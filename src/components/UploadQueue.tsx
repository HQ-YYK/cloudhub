import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { FilesRequestError } from '../api/files'
import { MAX_FILE_SIZE, UploadsRequestError, uploadFile } from '../api/uploads'

export type UploadQueueHandle = {
  enqueue: (files: File[], parentId: string | null) => void
}

type UploadStatus = 'waiting' | 'uploading' | 'done' | 'failed' | 'cancelled'

type UploadQueueItem = {
  key: string
  file: File
  parentId: string | null
  status: UploadStatus
  receivedBytes: number
  totalBytes: number
  error: string
}

function uploadErrorMessage(error: unknown): string {
  if (error instanceof FilesRequestError) {
    if (error.code === 'conflict') return '当前目录已有同名文件'
    if (error.code === 'storage_not_connected') return '管理员尚未连接 Google Drive'
    if (error.code === 'storage_not_configured') return '存储尚未配置'
    if (error.code === 'upload_expired') return '上传会话已过期，请重试'
    if (error.code === 'empty_file') return '不支持空文件'
    if (error.code === 'invalid_size') return '文件超过 10 GiB 上限'
    if (error.code === 'invalid_name') return '文件名无效'
    if (error.code === 'password_change_required') return '请先修改密码'
    if (error.status === 401) return '登录状态已失效'
    if (error.status === 403) return '请求来源未通过安全校验，请刷新页面后重试。'
    if (error.code === 'network_error') return '网络连接失败'
  }
  return '上传失败，请稍后重试'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function makeItem(key: string, file: File, parentId: string | null, status: UploadStatus, error = ''): UploadQueueItem {
  return { key, file, parentId, status, receivedBytes: 0, totalBytes: file.size, error }
}

function validateFile(file: File): string {
  if (file.size === 0) return '不支持空文件'
  if (file.size > MAX_FILE_SIZE) return '文件超过 10 GiB 上限'
  return ''
}

function statusLabel(item: UploadQueueItem): string {
  if (item.status === 'waiting') return '等待中'
  if (item.status === 'uploading') return '上传中'
  if (item.status === 'done') return '已完成'
  if (item.status === 'cancelled') return '已取消'
  return item.error
}

function canCancel(item: UploadQueueItem): boolean {
  return item.status === 'waiting' || item.status === 'uploading'
}

function canRetry(item: UploadQueueItem): boolean {
  return item.status === 'failed' && validateFile(item.file) === ''
}

function canRemove(item: UploadQueueItem): boolean {
  return item.status === 'done' || item.status === 'failed' || item.status === 'cancelled'
}

export const UploadQueue = forwardRef<UploadQueueHandle, { onItemDone: (parentId: string | null) => void }>(
  function UploadQueue({ onItemDone }, ref) {
    const [items, setItems] = useState<UploadQueueItem[]>([])
    const itemsRef = useRef(items)
    const onItemDoneRef = useRef(onItemDone)
    const busyRef = useRef(false)

    // Declared before the queue effect so refs are current when the queue runs.
    useEffect(() => {
      itemsRef.current = items
      onItemDoneRef.current = onItemDone
    }, [items, onItemDone])
    const controllersRef = useRef(new Map<string, AbortController>())
    const nextKeyRef = useRef(0)

    const patchItem = useCallback((key: string, patch: Partial<UploadQueueItem>) => {
      setItems((previous) => previous.map((item) => (item.key === key ? { ...item, ...patch } : item)))
    }, [])

    const processQueue = useCallback(async () => {
      if (busyRef.current) return
      busyRef.current = true
      try {
        while (true) {
          const next = itemsRef.current.find((item) => item.status === 'waiting')
          if (!next) break
          const controller = new AbortController()
          controllersRef.current.set(next.key, controller)
          patchItem(next.key, { status: 'uploading', error: '' })
          try {
            await uploadFile(next.file, next.parentId, {
              onProgress: (receivedBytes, totalBytes) => patchItem(next.key, { receivedBytes, totalBytes }),
              signal: controller.signal,
            })
            patchItem(next.key, { status: 'done', receivedBytes: next.file.size, totalBytes: next.file.size })
            onItemDoneRef.current(next.parentId)
          } catch (error) {
            if (error instanceof UploadsRequestError && error.code === 'aborted') {
              patchItem(next.key, { status: 'cancelled' })
            } else {
              patchItem(next.key, { status: 'failed', error: uploadErrorMessage(error) })
            }
          } finally {
            controllersRef.current.delete(next.key)
          }
        }
      } finally {
        busyRef.current = false
      }
    }, [patchItem])

    useEffect(() => {
      void processQueue()
    }, [items, processQueue])

    const enqueue = useCallback((files: File[], parentId: string | null) => {
      const additions = files.map((file) => {
        const key = `upload-${nextKeyRef.current}`
        nextKeyRef.current += 1
        const error = validateFile(file)
        return error ? makeItem(key, file, parentId, 'failed', error) : makeItem(key, file, parentId, 'waiting')
      })
      setItems((previous) => [...previous, ...additions])
    }, [])

    const cancel = useCallback((key: string) => {
      const item = itemsRef.current.find((entry) => entry.key === key)
      if (!item) return
      if (item.status === 'waiting') {
        patchItem(key, { status: 'cancelled' })
        return
      }
      if (item.status === 'uploading') controllersRef.current.get(key)?.abort()
    }, [patchItem])

    const retry = useCallback((key: string) => {
      patchItem(key, { status: 'waiting', receivedBytes: 0, error: '' })
    }, [patchItem])

    const remove = useCallback((key: string) => {
      setItems((previous) => previous.filter((item) => item.key !== key))
    }, [])

    const clearCompleted = useCallback(() => {
      setItems((previous) => previous.filter((item) => item.status !== 'done'))
    }, [])

    const close = useCallback(() => {
      for (const controller of controllersRef.current.values()) controller.abort()
      controllersRef.current.clear()
      setItems([])
    }, [])

    useImperativeHandle(ref, () => ({ enqueue }), [enqueue])

    const hasInProgress = items.some((item) => item.status === 'waiting' || item.status === 'uploading')
    const hasCompleted = items.some((item) => item.status === 'done')

    useEffect(() => {
      if (!hasInProgress) return
      function warnBeforeUnload(event: BeforeUnloadEvent) {
        event.preventDefault()
        event.returnValue = ''
      }
      window.addEventListener('beforeunload', warnBeforeUnload)
      return () => window.removeEventListener('beforeunload', warnBeforeUnload)
    }, [hasInProgress])

    if (items.length === 0) return null

    return (
      <div className="upload-queue" aria-label="上传队列">
        <div className="upload-queue-header">
          <h3>上传队列</h3>
          <div className="upload-queue-header-actions">
            {hasCompleted && <button type="button" onClick={clearCompleted}>清除已完成</button>}
            <button type="button" onClick={close}>关闭</button>
          </div>
        </div>
        <ul className="upload-queue-list">
          {items.map((item) => {
            const percent = item.totalBytes > 0 ? Math.min(100, Math.round((item.receivedBytes / item.totalBytes) * 100)) : 0
            return (
              <li className="upload-queue-item" key={item.key}>
                <div className="upload-queue-row">
                  <span className="upload-queue-name" title={item.file.name}>{item.file.name}</span>
                  <span className="upload-queue-size">{formatBytes(item.receivedBytes)} / {formatBytes(item.totalBytes)}</span>
                  <span className={`upload-queue-status is-${item.status}`}>{statusLabel(item)}</span>
                  <span className="upload-queue-controls">
                    {canCancel(item) && <button type="button" onClick={() => cancel(item.key)}>取消</button>}
                    {canRetry(item) && <button type="button" onClick={() => retry(item.key)}>重试</button>}
                    {canRemove(item) && <button type="button" onClick={() => remove(item.key)}>移除</button>}
                  </span>
                </div>
                <div
                  className="upload-progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={item.totalBytes}
                  aria-valuenow={item.receivedBytes}
                  aria-label={`${item.file.name} 上传进度`}
                >
                  <span className="upload-progress-fill" style={{ width: `${percent}%` }} />
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    )
  },
)
