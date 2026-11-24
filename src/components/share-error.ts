import { SharesRequestError } from '../api/shares'

export function shareErrorMessage(error: unknown): string {
  if (error instanceof SharesRequestError) {
    if (error.code === 'too_many_shares') return '这个文件的分享链接已达上限（20 个），请先撤销一些再试。'
    if (error.code === 'password_change_required') return '请先修改密码。'
    if (error.status === 401) return '登录状态已失效，请重新登录后继续。'
    if (error.status === 403) return '请求来源未通过安全校验，请刷新页面后重试。'
    if (error.status === 404) return '文件不存在或已不可访问。'
    if (error.status === 503) return '存储暂时不可用，请稍后重试。'
    if (error.status === 0) return '网络连接失败，请检查网络后重试。'
  }
  return '操作失败，请稍后重试。'
}
