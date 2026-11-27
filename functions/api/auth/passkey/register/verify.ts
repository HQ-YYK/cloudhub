import type { PagesFunction } from '@cloudflare/workers-types'
import { getAuthenticatedUser, sha256 } from '../../../../_lib/auth.ts'
import type { AuthRepository } from '../../../../_lib/auth-repository.ts'
import type { AuthEnv } from '../../../../_lib/cloudflare-env.ts'
import { createD1AuthRepository } from '../../../../_lib/d1-auth-repository.ts'
import { createD1PasskeyRepository } from '../../../../_lib/d1-passkey-repository.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../../_lib/http.ts'
import type { PasskeyRepository } from '../../../../_lib/passkey-repository.ts'
import { verifyRegistration } from '../../../../_lib/webauthn.ts'

const MAX_BODY_LENGTH = 4096

interface RegisterVerifyDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createPasskeyRepository: (env: AuthEnv) => PasskeyRepository
}

export function createPasskeyRegisterVerifyHandler(
  overrides: Partial<RegisterVerifyDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: RegisterVerifyDependencies = {
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
      publicKey?: unknown
      publicKeyAlgorithm?: unknown
      transports?: unknown
      name?: unknown
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
      typeof payload.publicKey !== 'string' ||
      typeof payload.publicKeyAlgorithm !== 'number'
    ) {
      return jsonResponse({ error: 'invalid_request' }, 400)
    }

    let name = 'Passkey'
    if (payload.name !== undefined && payload.name !== null) {
      if (typeof payload.name !== 'string') return jsonResponse({ error: 'invalid_request' }, 400)
      name = payload.name.trim()
      if (name === '') name = 'Passkey'
      else if (name.length > 64) return jsonResponse({ error: 'invalid_request' }, 400)
    }

    let transports: string[] | null = null
    if (payload.transports !== undefined && payload.transports !== null) {
      if (
        !Array.isArray(payload.transports) ||
        payload.transports.some((item) => typeof item !== 'string' || item.length > 32)
      ) {
        return jsonResponse({ error: 'invalid_request' }, 400)
      }
      transports = payload.transports
    }

    try {
      const authRepository = dependencies.createAuthRepository(context.env)
      const passkeyRepository = dependencies.createPasskeyRepository(context.env)
      const user = await getAuthenticatedUser(authRepository, context.request)
      if (!user) return jsonResponse({ error: 'unauthorized' }, 401)

      const challengeHash = await sha256(payload.challenge)
      const challenge = await passkeyRepository.findWebauthnChallenge(challengeHash, new Date().toISOString())
      if (!challenge || challenge.purpose !== 'register' || challenge.user_id !== user.id) {
        return jsonResponse({ error: 'invalid_request' }, 400)
      }

      const result = await verifyRegistration({
        rpId: new URL(context.request.url).hostname,
        origin: new URL(context.request.url).origin,
        challengeHash,
        credentialId: payload.credentialId,
        clientDataJSON: payload.clientDataJSON,
        authenticatorData: payload.authenticatorData,
        publicKeySpki: payload.publicKey,
        algorithm: payload.publicKeyAlgorithm,
      })
      if (result === 'unsupported_algorithm') return jsonResponse({ error: 'unsupported_algorithm' }, 400)
      if (result === 'invalid_passkey') return jsonResponse({ error: 'invalid_passkey' }, 400)
      if (result !== 'ok') return jsonResponse({ error: 'invalid_request' }, 400)

      const duplicate = await passkeyRepository.findPasskeyById(payload.credentialId)
      if (duplicate) return jsonResponse({ error: 'passkey_exists' }, 409)

      const consumed = await passkeyRepository.consumeWebauthnChallenge(challengeHash, new Date().toISOString())
      if (!consumed) return jsonResponse({ error: 'invalid_request' }, 400)

      const now = new Date().toISOString()
      const created = await passkeyRepository.createPasskey({
        id: payload.credentialId,
        userId: user.id,
        publicKey: payload.publicKey,
        algorithm: payload.publicKeyAlgorithm,
        signCount: 0,
        name,
        transports: transports && transports.length > 0 ? JSON.stringify(transports) : null,
        createdAt: now,
      })
      if (!created) return jsonResponse({ error: 'passkey_exists' }, 409)

      return jsonResponse({
        passkey: { id: payload.credentialId, name, createdAt: now, lastUsedAt: null, prf: false },
      }, 201)
    } catch (error) {
      console.error('Passkey register verify request failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createPasskeyRegisterVerifyHandler()
