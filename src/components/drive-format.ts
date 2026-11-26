import { FilesRequestError, type DriveItem } from '../api/files'
import { plainSizeFromCipher } from '../crypto'

export function requestErrorMessage(error: unknown, action: 'list' | 'create' | 'download' | 'delete') {
  if (error instanceof FilesRequestError) {
    if (error.code === 'password_change_required') return '请先修改密码'
    if (error.code === 'folder_too_large') return '文件夹内容超过 5000 项，请先分批删除里面的内容'
    if (error.code === 'folder_busy') return '文件夹里有正在上传的文件，请等上传完成后再删除'
    if (error.status === 401) return '登录状态已失效，请重新登录后继续。'
    if (error.status === 403) return '请求来源未通过安全校验，请刷新页面后重试。'
    if (error.status === 409) return '当前目录中已经存在同名文件夹。'
    if (error.status === 404) {
      return action === 'delete' ? '文件不存在或已被删除。' : '目录或文件不存在或已不可访问。'
    }
    if (error.status === 400) {
      return action === 'create' ? '文件夹名称无效，请检查后重试。' : '请求无效，请检查后重试。'
    }
    if (error.status === 0) return '网络连接失败，请检查网络后重试。'
  }
  const messages = {
    list: '目录加载失败，请稍后重试。',
    create: '文件夹创建失败，请稍后重试。',
    download: '文件下载失败，请稍后重试。',
    delete: '删除失败，请稍后重试。',
  } satisfies Record<typeof action, string>
  return messages[action]
}

export function renameErrorMessage(error: unknown) {
  if (error instanceof FilesRequestError) {
    if (error.code === 'name_conflict' || error.code === 'conflict') return '目标位置已有同名文件或文件夹'
    if (error.code === 'invalid_move') return '不能移动到它自己的子文件夹里'
    if (error.code === 'not_ready') return '文件还没上传完成'
    if (error.code === 'invalid_name') return '名称无效，请检查后重试。'
    if (error.code === 'legacy_file') return '旧的未加密文件不能改名，请重新上传'
    if (error.code === 'password_change_required') return '请先修改密码'
    if (error.status === 401) return '登录状态已失效，请重新登录后继续。'
    if (error.status === 403) return '请求来源未通过安全校验，请刷新页面后重试。'
    if (error.status === 404) return '目录或文件不存在或已不可访问。'
    if (error.status === 0) return '网络连接失败，请检查网络后重试。'
  }
  return '重命名失败，请稍后重试。'
}

export function formatFileSize(size: number | null) {
  if (size === null) return '大小未知'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function plainSizeLabel(item: DriveItem): string {
  if (item.enc !== 1) return formatFileSize(item.size_bytes)
  if (item.size_bytes === null) return '大小未知'
  try {
    return formatFileSize(plainSizeFromCipher(item.size_bytes))
  } catch {
    return '大小未知'
  }
}

export function formatUpdatedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '更新时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}
