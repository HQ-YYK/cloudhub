import type { PagesFunction } from '@cloudflare/workers-types'
import { getAuthenticatedUser, sha256 } from '../../../../_lib/auth.ts'
import type { AuthRepository } from '../../../../_lib/auth-repository.ts'
import type { AuthEnv } from '../../../../_lib/cloudflare-env.ts'
import { createD1AuthRepository } from '../../../../_lib/d1-auth-repository.ts'
import { createD1PasskeyRepository } from '../../../../_lib/d1-passkey-repository.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../../_lib/http.ts'
import type { PasskeyRepository } from '../../../../_lib/passkey-repository.ts'
import {
  createWebauthnChallenge,
  encodeBase64Url,
  parseTransportsJson,
} from '../../../../_lib/webauthn.ts'

const PASSKEY_LIMIT = 10
const CHALLENGE_TTL_MS = 5 * 60 * 1000

interface RegisterOptionsDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createPasskeyRepository: (env: AuthEnv) => PasskeyRepository
}

export function createPasskeyRegisterOptionsHandler(
  overrides: Partial<RegisterOptionsDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: RegisterOptionsDependencies = {
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

    try {
      const authRepository = dependencies.createAuthRepository(context.env)
      const passkeyRepository = dependencies.createPasskeyRepository(context.env)
      const user = await getAuthenticatedUser(authRepository, context.request)
      if (!user) return jsonResponse({ error: 'unauthorized' }, 401)
      if (user.mustChangePassword) return jsonResponse({ error: 'password_change_required' }, 403)
      if (!user.keysReady) return jsonResponse({ error: 'keys_not_ready' }, 409)

      const count = await passkeyRepository.countPasskeys(user.id)
      if (count >= PASSKEY_LIMIT) return jsonResponse({ error: 'passkey_limit' }, 409)

      const challenge = createWebauthnChallenge()
      const now = new Date()
      const ip = context.request.headers.get('CF-Connecting-IP') ?? 'unknown'
      await passkeyRepository.createWebauthnChallenge({
        id: crypto.randomUUID(),
        userId: user.id,
        purpose: 'register',
        challengeHash: await sha256(challenge),
        ipHash: await sha256(ip),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString(),
      })

      const existing = await passkeyRepository.listPasskeys(user.id)
      const excludeCredentials = existing.map((credential) => {
        const transports = parseTransportsJson(credential.transports)
        return {
          type: 'public-key',
          id: credential.id,
          ...(transports ? { transports } : {}),
        }
      })

      return jsonResponse({
        challenge,
        rp: { id: new URL(context.request.url).hostname, name: 'CloudHub' },
        user: { id: encodeBase64Url(user.id), name: user.username, displayName: user.username },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        excludeCredentials,
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        attestation: 'none',
        timeout: 300000,
      })
    } catch (error) {
      console.error('Passkey register options request failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createPasskeyRegisterOptionsHandler()
