export const PLATFORM_LIMIT_MESSAGE = '今天的免费请求额度可能已经用完，北京时间早上 8 点自动恢复。已上传的文件不受影响。'
export const PLATFORM_UNAVAILABLE_MESSAGE = '服务暂时不可用，请稍后重试。'

export type PlatformErrorCode = 'platform_limited' | 'platform_unavailable'

// Cloudflare's free-plan error page (e.g. error 1027) is not our JSON; it is
// treated as a 429 here so users see a quota message instead of a generic one.
export function classifyPlatformResponse(status: number, contentType: string | null): PlatformErrorCode | null {
  if (contentType?.includes('application/json')) return null
  if (status === 429) return 'platform_limited'
  if (status >= 500) return 'platform_unavailable'
  return null
}

export function platformErrorMessage(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  if (code === 'platform_limited') return PLATFORM_LIMIT_MESSAGE
  if (code === 'platform_unavailable') return PLATFORM_UNAVAILABLE_MESSAGE
  return null
}
