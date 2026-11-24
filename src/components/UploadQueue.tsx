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

type SpeedSample = { time: number; receivedBytes: number }

const SPEED_WINDOW_MS = 5000
const MAX_CONCURRENT_UPLOADS = 3

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

function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

function formatRemaining(seconds: number): string {
  const total = Math.max(1, Math.round(seconds))
  if (total < 60) return `${total} 秒`
  if (total < 3600) {
    const minutes = Math.floor(total / 60)
    const secs = total % 60
    return `${minutes} 分 ${secs} 秒`
  }
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  return `${hours} 小时 ${minutes} 分`
}

// Speed over the last SPEED_WINDOW_MS, using the first and last samples in the window.
function computeSpeed(samples: SpeedSample[]): number | null {
  if (samples.length < 2) return null
  const first = samples[0]
  const last = samples[samples.length - 1]
  const elapsedMs = last.time - first.time
  if (elapsedMs < 1000) return null
  const bytes = last.receivedBytes - first.receivedBytes
  if (bytes <= 0) return null
  return (bytes / elapsedMs) * 1000
}

function makeItem(key: string, file: File, parentId: string | null, status: UploadStatus, error = ''): UploadQueueItem {
  return { key, file, parentId, status, receivedBytes: 0, totalBytes: file.size, error }
}

function validateFile(file: File): string {
  if (file.size === 0) return '不支持空文件'
  if (file.size > MAX_FILE_SIZE) return '文件超过 10 GiB 上限'
  return ''
}

function statusLabel(item: UploadQueueItem, samples: SpeedSample[]): string {
  if (item.status === 'uploading') {
    const percent = item.totalBytes > 0 ? Math.min(100, Math.round((item.receivedBytes / item.totalBytes) * 100)) : 0
    const speed = computeSpeed(samples)
    if (speed === null) return `${percent}% · 计算中`
    const remainingSeconds = (item.totalBytes - item.receivedBytes) / speed
    return `${percent}% · ${formatSpeed(speed)} · 剩余约 ${formatRemaining(remainingSeconds)}`
  }
  if (item.status === 'done') return '已完成'
  if (item.status === 'cancelled') return '已取消'
  if (item.status === 'failed') return item.error
  return '等待中'
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
    const [collapsed, setCollapsed] = useState(false)
    const itemsRef = useRef(items)
    const onItemDoneRef = useRef(onItemDone)
    const activeKeysRef = useRef(new Set<string>())
    const samplesRef = useRef(new Map<string, SpeedSample[]>())

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

    const recordSample = useCallback((key: string, receivedBytes: number) => {
      const now = Date.now()
      const list = samplesRef.current.get(key) ?? []
      list.push({ time: now, receivedBytes })
      while (list.length > 0 && now - list[0].time > SPEED_WINDOW_MS) list.shift()
      samplesRef.current.set(key, list)
    }, [])

    const dropSamples = useCallback((key: string) => {
      samplesRef.current.delete(key)
    }, [])

    const runUpload = useCallback(async (item: UploadQueueItem) => {
      const controller = new AbortController()
      controllersRef.current.set(item.key, controller)
      patchItem(item.key, { status: 'uploading', error: '' })
      try {
        await uploadFile(item.file, item.parentId, {
          onProgress: (receivedBytes, totalBytes) => {
            recordSample(item.key, receivedBytes)
            patchItem(item.key, { receivedBytes, totalBytes })
          },
          signal: controller.signal,
        })
        patchItem(item.key, { status: 'done', receivedBytes: item.file.size, totalBytes: item.file.size })
        dropSamples(item.key)
        onItemDoneRef.current(item.parentId)
      } catch (error) {
        dropSamples(item.key)
        if (error instanceof UploadsRequestError && error.code === 'aborted') {
          patchItem(item.key, { status: 'cancelled' })
        } else {
          patchItem(item.key, { status: 'failed', error: uploadErrorMessage(error) })
        }
      } finally {
        controllersRef.current.delete(item.key)
        activeKeysRef.current.delete(item.key)
      }
    }, [patchItem, recordSample, dropSamples])

    const pump = useCallback(() => {
      const available = MAX_CONCURRENT_UPLOADS - activeKeysRef.current.size
      if (available <= 0) return
      const waiting = itemsRef.current
        .filter((item) => item.status === 'waiting' && !activeKeysRef.current.has(item.key))
        .slice(0, available)
      for (const item of waiting) {
        activeKeysRef.current.add(item.key)
        void runUpload(item)
      }
    }, [runUpload])

    useEffect(() => {
      void pump()
    }, [items, pump])

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
      dropSamples(key)
      patchItem(key, { status: 'waiting', receivedBytes: 0, error: '' })
    }, [patchItem, dropSamples])

    const remove = useCallback((key: string) => {
      dropSamples(key)
      setItems((previous) => previous.filter((item) => item.key !== key))
    }, [dropSamples])

    const clearCompleted = useCallback(() => {
      for (const item of itemsRef.current) {
        if (item.status === 'done') dropSamples(item.key)
      }
      setItems((previous) => previous.filter((item) => item.status !== 'done'))
    }, [dropSamples])

    const close = useCallback(() => {
      for (const controller of controllersRef.current.values()) controller.abort()
      controllersRef.current.clear()
      activeKeysRef.current.clear()
      samplesRef.current.clear()
      setItems([])
    }, [])

    useImperativeHandle(ref, () => ({ enqueue }), [enqueue])

    const hasInProgress = items.some((item) => item.status === 'waiting' || item.status === 'uploading')
    const hasCompleted = items.some((item) => item.status === 'done')
    const doneCount = items.filter((item) => item.status === 'done').length
    const activeItems = items.filter((item) => item.status !== 'failed' && item.status !== 'cancelled')
    const totalReceived = activeItems.reduce((sum, item) => sum + item.receivedBytes, 0)
    const totalBytes = activeItems.reduce((sum, item) => sum + item.totalBytes, 0)
    const totalPercent = totalBytes > 0 ? Math.min(100, Math.round((totalReceived / totalBytes) * 100)) : 0
    const uploadingCount = items.filter((item) => item.status === 'uploading').length
    const totalSpeed = items.filter((item) => item.status === 'uploading').reduce((sum, item) => {
      const speed = computeSpeed(samplesRef.current.get(item.key) ?? [])
      return sum + (speed ?? 0)
    }, 0)
    const totalSpeedLabel = uploadingCount > 1 && totalSpeed > 0 ? ` · ${formatSpeed(totalSpeed)}` : ''

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
          <div className="upload-queue-title">
            <h3>上传队列</h3>
            <span className="upload-queue-count">已完成 {doneCount} / 共 {items.length}</span>
            {hasInProgress && <span className="upload-queue-total-percent">{totalPercent}%{totalSpeedLabel}</span>}
          </div>
          <div className="upload-queue-header-actions">
            {hasCompleted && <button type="button" onClick={clearCompleted}>清除已完成</button>}
            <button type="button" onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed}>
              {collapsed ? '展开' : '收起'}
            </button>
            <button type="button" onClick={close}>关闭</button>
          </div>
        </div>
        {collapsed ? (
          <div
            className="upload-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={totalBytes}
            aria-valuenow={totalReceived}
            aria-label="上传总进度"
          >
            <span className="upload-progress-fill" style={{ width: `${totalPercent}%` }} />
          </div>
        ) : (
          <ul className="upload-queue-list">
            {items.map((item) => {
              const percent = item.totalBytes > 0 ? Math.min(100, Math.round((item.receivedBytes / item.totalBytes) * 100)) : 0
              const samples = samplesRef.current.get(item.key) ?? []
              const fillClass = item.status === 'done'
                ? 'upload-progress-fill is-done'
                : item.status === 'failed'
                  ? 'upload-progress-fill is-failed'
                  : 'upload-progress-fill'
              return (
                <li className="upload-queue-item" key={item.key}>
                  <div className="upload-queue-row">
                    <span className="upload-queue-name" title={item.file.name}>{item.file.name}</span>
                    <span className="upload-queue-size">{formatBytes(item.receivedBytes)} / {formatBytes(item.totalBytes)}</span>
                    <span className={`upload-queue-status is-${item.status}`}>{statusLabel(item, samples)}</span>
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
                    <span className={fillClass} style={{ width: `${percent}%` }} />
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    )
  },
)
