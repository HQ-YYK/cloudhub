import { useEffect, useRef, useState } from 'react'
import { FilesRequestError, listFiles, moveItem, type DriveItem } from '../api/files'

interface MoveDialogProps {
  item: DriveItem
  parentName: string
  onClose: () => void
  onMoved: () => void
  onError: (message: string) => void
}

interface FolderNode {
  id: string | null
  name: string
}

function moveErrorMessage(error: unknown): string {
  if (error instanceof FilesRequestError) {
    if (error.code === 'invalid_move') return '不能移动到它自己的子文件夹里'
    if (error.code === 'conflict') return '目标位置已有同名文件或文件夹'
    if (error.code === 'not_ready') return '文件还没上传完成'
    if (error.status === 401) return '登录状态已失效，请重新登录后继续。'
    if (error.status === 403) return '请求来源未通过安全校验，请刷新页面后重试。'
    if (error.status === 404) return '目录或文件不存在或已不可访问。'
    if (error.status === 0) return '网络连接失败，请检查网络后重试。'
  }
  return '移动失败，请稍后重试。'
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      aria-hidden="true"
      className={`move-tree-chevron${open ? ' is-open' : ''}`}
    >
      <path d="M5.5 3.25 10 8l-4.5 4.75" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
      <path d="M2.75 7.25A2.25 2.25 0 0 1 5 5h4.1l2.05 2.25H19A2.25 2.25 0 0 1 21.25 9.5v7.25A2.25 2.25 0 0 1 19 19H5a2.25 2.25 0 0 1-2.25-2.25V7.25Z" fill="currentColor" />
      <path d="M2.75 10.25H21.25v6.5A2.25 2.25 0 0 1 19 19H5a2.25 2.25 0 0 1-2.25-2.25v-6.5Z" fill="white" fillOpacity=".22" />
    </svg>
  )
}

function FolderRow({ node, depth, selectedId, disabledId, onSelect }: {
  node: FolderNode
  depth: number
  selectedId: string | null
  disabledId: string | null
  onSelect: (id: string | null, name: string) => void
}) {
  const [children, setChildren] = useState<FolderNode[] | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const self = node.id !== null && node.id === disabledId
  const selected = selectedId === node.id
  const leaf = children !== null && children.length === 0

  async function toggle() {
    if (self) return
    onSelect(node.id, node.name)
    if (expanded) {
      setExpanded(false)
      return
    }
    if (children === null) {
      setLoading(true)
      try {
        const items = await listFiles(node.id)
        setChildren(items.filter((entry) => entry.kind === 'directory').map((entry) => ({ id: entry.id, name: entry.name })))
      } catch {
        setChildren([])
      } finally {
        setLoading(false)
      }
    }
    setExpanded(true)
  }

  return (
    <div className="move-tree-node" role="treeitem" aria-expanded={expanded}>
      <button
        type="button"
        className={`move-tree-row${selected ? ' is-selected' : ''}${self ? ' is-disabled' : ''}`}
        style={{ paddingLeft: `${12 + depth * 18}px` }}
        onClick={() => void toggle()}
        disabled={self}
        aria-current={selected ? 'true' : undefined}
      >
        <span className="move-tree-toggle" aria-hidden="true">
          {!self && !leaf ? <ChevronIcon open={expanded} /> : <span className="move-tree-toggle-spacer" />}
        </span>
        <span className="move-tree-folder-icon" aria-hidden="true"><FolderIcon /></span>
        <span className="move-tree-name">{node.name}</span>
      </button>
      {expanded && (
        <div role="group">
          {loading ? (
            <p className="move-tree-loading">正在加载…</p>
          ) : (
            (children ?? []).map((child) => (
              <FolderRow
                key={child.id}
                node={child}
                depth={depth + 1}
                selectedId={selectedId}
                disabledId={disabledId}
                onSelect={onSelect}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

export default function MoveDialog({ item, parentName, onClose, onMoved, onError }: MoveDialogProps) {
  const [selectedId, setSelectedId] = useState<string | null>(item.parent_id)
  const [selectedName, setSelectedName] = useState<string>(parentName)
  const [moving, setMoving] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !moving) onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, moving])

  const unchanged = selectedId === item.parent_id

  async function handleMove() {
    if (unchanged || moving) return
    setMoving(true)
    try {
      await moveItem(item.id, selectedId)
      onMoved()
    } catch (error) {
      onError(moveErrorMessage(error))
      onClose()
    } finally {
      setMoving(false)
    }
  }

  return (
    <div className="move-dialog-backdrop" onClick={onClose}>
      <div
        className="move-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-dialog-title"
        tabIndex={-1}
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="move-dialog-header">
          <h3 id="move-dialog-title">移动“{item.name}”到…</h3>
          <button type="button" className="move-dialog-close" onClick={onClose} aria-label="关闭">
            <CloseIcon />
          </button>
        </div>
        <div className="move-dialog-tree" role="tree" aria-label="选择目标文件夹">
          <FolderRow
            node={{ id: null, name: '我的云盘' }}
            depth={0}
            selectedId={selectedId}
            disabledId={item.kind === 'directory' ? item.id : null}
            onSelect={(id, name) => {
              setSelectedId(id)
              setSelectedName(name)
            }}
          />
        </div>
        <div className="move-dialog-footer">
          <button type="button" className="secondary-small-button" onClick={onClose} disabled={moving}>取消</button>
          <button type="button" className="primary-small-button" onClick={() => void handleMove()} disabled={unchanged || moving}>
            {moving ? '移动中…' : `移动到这里（${selectedName}）`}
          </button>
        </div>
      </div>
    </div>
  )
}
