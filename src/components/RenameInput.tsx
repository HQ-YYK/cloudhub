import { useEffect, useRef, useState } from 'react'
import type { DriveItem } from '../api/files'

export default function RenameInput({ item, saving, onSave, onCancel }: {
  item: DriveItem
  saving: boolean
  onSave: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(item.name)
  const inputRef = useRef<HTMLInputElement>(null)
  const committedRef = useRef(false)

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    const dot = item.kind === 'file' ? item.name.lastIndexOf('.') : -1
    const end = item.kind === 'file' && dot > 0 ? dot : item.name.length
    input.setSelectionRange(0, end)
  }, [item])

  function commit() {
    if (committedRef.current) return
    const name = value.trim()
    if (!name || name === item.name) {
      committedRef.current = true
      onCancel()
      return
    }
    committedRef.current = true
    onSave(name)
  }

  return (
    <input
      ref={inputRef}
      className="drive-rename-input"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          committedRef.current = true
          onCancel()
        }
      }}
      onBlur={commit}
      disabled={saving}
      maxLength={255}
      aria-label={`重命名 ${item.name}`}
    />
  )
}
