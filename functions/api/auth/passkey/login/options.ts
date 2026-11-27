import type { PagesFunction } from '@cloudflare/workers-types'
import { sha256 } from '../../../../_lib/auth.ts'
import type { AuthEnv } from '../../../../_lib/cloudflare-env.ts'
import { createD1PasskeyRepository } from '../../../../_lib/d1-passkey-repository.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../../_lib/http.ts'
import type { PasskeyRepository } from '../../../../_lib/passkey-repository.ts'
import { createWebauthnChallenge } from '../../../../_lib/webauthn.ts'

const CHALLENGE_TTL_MS = 5 * 60 * 1000

interface LoginOptionsDependencies {
  createPasskeyRepository: (env: AuthEnv) => PasskeyRepository
}

export function createPasskeyLoginOptionsHandler(
  overrides: Partial<LoginOptionsDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: LoginOptionsDependencies = {
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
      const passkeyRepository = dependencies.createPasskeyRepository(context.env)
      const challenge = createWebauthnChallenge()
      const now = new Date()
      const ip = context.request.headers.get('CF-Connecting-IP') ?? 'unknown'
      await passkeyRepository.createWebauthnChallenge({
        id: crypto.randomUUID(),
        userId: null,
        purpose: 'login',
        challengeHash: await sha256(challenge),
        ipHash: await sha256(ip),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString(),
      })

      return jsonResponse({
        challenge,
        rpId: new URL(context.request.url).hostname,
        userVerification: 'required',
        timeout: 300000,
      })
    } catch (error) {
      console.error('Passkey login options request failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createPasskeyLoginOptionsHandler()
