import { useEffect, useRef, useState } from 'react'
import type { DriveItem } from '../api/files'
import { checkName, nameProblemMessage } from '../files/names'

export default function RenameInput({ item, name, saving, onSave, onCancel }: {
  item: DriveItem
  name: string
  saving: boolean
  onSave: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(name)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const committedRef = useRef(false)

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    const dot = item.kind === 'file' ? name.lastIndexOf('.') : -1
    const end = item.kind === 'file' && dot > 0 ? dot : name.length
    input.setSelectionRange(0, end)
  }, [item, name])

  function commit() {
    if (committedRef.current || saving) return
    const check = checkName(value)
    if (!check.ok) {
      setError(nameProblemMessage(check.problem, check.length))
      return
    }
    if (check.normalized === name) {
      committedRef.current = true
      onCancel()
      return
    }
    committedRef.current = true
    onSave(check.normalized)
  }

  return (
    <span className="drive-rename-wrap">
      <input
        ref={inputRef}
        className="drive-rename-input"
        value={value}
        onChange={(event) => {
          setValue(event.target.value)
          if (error) setError('')
        }}
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
        aria-label={`重命名 ${name}`}
      />
      {error && <span className="drive-rename-error" role="alert">{error}</span>}
    </span>
  )
}
