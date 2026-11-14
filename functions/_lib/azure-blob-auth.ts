import { BlobStoreError } from './blob-store.ts'

export interface AzureAccessTokenProvider {
  getAccessToken(): Promise<string>
}

export interface AzureClientCredentialsOptions {
  tenantId: string
  clientId: string
  clientSecret: string
  fetchImpl?: typeof fetch
  now?: () => number
  refreshSkewMs?: number
}

const AZURE_STORAGE_SCOPE = 'https://storage.azure.com/.default'
const DEFAULT_REFRESH_SKEW_MS = 60_000

function invalidConfiguration() {
  return new BlobStoreError('invalid_request', 'azure_auth_configuration_invalid')
}

function authenticationUnavailable() {
  return new BlobStoreError('unavailable', 'azure_auth_unavailable')
}

export function createAzureClientCredentialsAuth(
  options: AzureClientCredentialsOptions,
): AzureAccessTokenProvider {
  if (
    options.tenantId.length === 0
    || options.clientId.length === 0
    || options.clientSecret.length === 0
    || options.refreshSkewMs !== undefined
      && (!Number.isSafeInteger(options.refreshSkewMs) || options.refreshSkewMs < 0)
  ) {
    throw invalidConfiguration()
  }

  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(options.tenantId)}/oauth2/v2.0/token`
  let cachedToken: { value: string; refreshAt: number } | null = null
  let pendingRequest: Promise<string> | null = null

  async function requestToken() {
    let response: Response
    try {
      response = await fetchImpl(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          grant_type: 'client_credentials',
          scope: AZURE_STORAGE_SCOPE,
        }),
        redirect: 'error',
      })
    } catch {
      throw authenticationUnavailable()
    }

    if (!response.ok) throw authenticationUnavailable()

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw authenticationUnavailable()
    }
    if (
      typeof payload !== 'object'
      || payload === null
      || !('access_token' in payload)
      || typeof payload.access_token !== 'string'
      || payload.access_token.length === 0
      || !('expires_in' in payload)
      || typeof payload.expires_in !== 'number'
      || !Number.isFinite(payload.expires_in)
      || payload.expires_in <= 0
    ) {
      throw authenticationUnavailable()
    }

    const expiresAt = now() + payload.expires_in * 1000
    return {
      value: payload.access_token,
      refreshAt: Math.max(now(), expiresAt - refreshSkewMs),
    }
  }

  return {
    async getAccessToken() {
      const currentTime = now()
      if (cachedToken && currentTime < cachedToken.refreshAt) {
        return cachedToken.value
      }
      if (!pendingRequest) {
        pendingRequest = requestToken()
          .then((token) => {
            cachedToken = token
            return token.value
          })
          .finally(() => {
            pendingRequest = null
          })
      }
      return pendingRequest
    },
  }
}
