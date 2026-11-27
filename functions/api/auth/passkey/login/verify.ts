import type { PagesFunction } from '@cloudflare/workers-types'
import {
  clearLoginFailures,
  createSession,
  createSessionToken,
  getLoginAttempt,
  hashSessionToken,
  isLoginBlocked,
  recordLoginFailure,
  sessionCookie,
  sha256,
} from '../../../../_lib/auth.ts'
import type { AuthRepository } from '../../../../_lib/auth-repository.ts'
import type { AuthEnv } from '../../../../_lib/cloudflare-env.ts'
import { createD1AuthRepository } from '../../../../_lib/d1-auth-repository.ts'
import { createD1PasskeyRepository } from '../../../../_lib/d1-passkey-repository.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../../_lib/http.ts'
import type { PasskeyRepository } from '../../../../_lib/passkey-repository.ts'
import { encodeBase64Url, verifyLoginAssertion } from '../../../../_lib/webauthn.ts'

const INVALID_CREDENTIALS = { error: 'invalid_credentials' }
const UNKNOWN_USERNAME = 'passkey:unknown'
const MAX_BODY_LENGTH = 4096

interface LoginVerifyDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createPasskeyRepository: (env: AuthEnv) => PasskeyRepository
}

export function createPasskeyLoginVerifyHandler(
  overrides: Partial<LoginVerifyDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: LoginVerifyDependencies = {
    createAuthRepository: (env) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1AuthRepository(env.DB)
    },
    createPasskeyRepository: (env) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1PasskeyRepository(env.DB)
    },
    ...overrides,
  }

  return async (context) => {
    if (context.request.method !== 'POST') return methodNotAllowed('POST')
    if (!sameOriginRequest(context.request)) return jsonResponse({ error: 'forbidden' }, 403)
    if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)

    let payload: {
      challenge?: unknown
      credentialId?: unknown
      clientDataJSON?: unknown
      authenticatorData?: unknown
      signature?: unknown
      userHandle?: unknown
    }
    try {
      const body = await context.request.text()
      if (body.length > MAX_BODY_LENGTH) return jsonResponse({ error: 'invalid_request' }, 400)
      payload = JSON.parse(body) as typeof payload
    } catch {
      return jsonResponse({ error: 'invalid_request' }, 400)
    }

    if (
      typeof payload.challenge !== 'string' ||
      typeof payload.credentialId !== 'string' ||
      typeof payload.clientDataJSON !== 'string' ||
      typeof payload.authenticatorData !== 'string' ||
      typeof payload.signature !== 'string' ||
      typeof payload.userHandle !== 'string'
    ) {
      return jsonResponse({ error: 'invalid_request' }, 400)
    }

    try {
      const authRepository = dependencies.createAuthRepository(context.env)
      const passkeyRepository = dependencies.createPasskeyRepository(context.env)
      const now = new Date()
      const ip = context.request.headers.get('CF-Connecting-IP') ?? 'unknown'
      const ipHash = await sha256(ip)

      const credential = await passkeyRepository.findPasskeyForLogin(payload.credentialId)
      const username = credential?.username ?? null
      const failureUsername = username ?? UNKNOWN_USERNAME

      if (username) {
        const attempt = await getLoginAttempt(authRepository, username, ipHash)
        if (isLoginBlocked(attempt, now)) return jsonResponse(INVALID_CREDENTIALS, 401)
      }

      const challengeHash = await sha256(payload.challenge)
      const challenge = await passkeyRepository.findWebauthnChallenge(challengeHash, now.toISOString())
      if (!challenge || challenge.purpose !== 'login') {
        await recordLoginFailure(authRepository, failureUsername, ipHash, now)
        return jsonResponse(INVALID_CREDENTIALS, 401)
      }

      let newSignCount: number | null = null
      if (credential && credential.disabled === 0) {
        newSignCount = await verifyLoginAssertion({
          rpId: new URL(context.request.url).hostname,
          origin: new URL(context.request.url).origin,
          challengeHash,
          publicKeySpki: credential.public_key,
          algorithm: credential.algorithm,
          signCount: credential.sign_count,
          clientDataJSON: payload.clientDataJSON,
          authenticatorData: payload.authenticatorData,
          signature: payload.signature,
          userHandle: payload.userHandle,
          expectedUserHandle: encodeBase64Url(credential.user_id),
        })
      }

      // Consume the challenge before deciding, so a failed assertion cannot be retried with it.
      const consumed = await passkeyRepository.consumeWebauthnChallenge(challengeHash, now.toISOString())

      if (!credential || newSignCount === null) {
        await recordLoginFailure(authRepository, failureUsername, ipHash, now)
        return jsonResponse(INVALID_CREDENTIALS, 401)
      }

      if (!consumed) return jsonResponse(INVALID_CREDENTIALS, 401)

      await passkeyRepository.updatePasskeyUsage(credential.id, newSignCount, now.toISOString())

      const token = createSessionToken()
      const tokenHash = await hashSessionToken(token)
      const timestamp = now.toISOString()
      const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()

      await createSession(authRepository, {
        id: crypto.randomUUID(),
        userId: credential.user_id,
        tokenHash,
        createdAt: timestamp,
        expiresAt,
        lastSeenAt: timestamp,
      })
      await clearLoginFailures(authRepository, credential.username, ipHash)

      return jsonResponse({
        user: {
          id: credential.user_id,
          username: credential.username,
          role: credential.role,
          mustChangePassword: credential.must_change_password === 1,
          keysReady: credential.wrapped_master_key !== null,
        },
        prfWrappedMasterKey: credential.prf_wrapped_master_key,
      }, 200, {
        'Set-Cookie': sessionCookie(token),
      })
    } catch (error) {
      console.error('Passkey login verify request failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createPasskeyLoginVerifyHandler()
