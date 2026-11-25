import { AuthRequestError } from '../api/auth.ts'

export function authErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof AuthRequestError) {
    if (error.status === 0) return '网络连接失败，请稍后重试。'
    if (error.code === 'invalid_credentials') return '当前密码不正确，或尝试次数过多，请稍后再试'
    if (error.code === 'keys_not_ready') return '账号还没有设置文件加密'
    if (error.code === 'reset_not_allowed') return '只有在管理员重置密码后才能放弃旧文件'
  }
  return fallback
}
