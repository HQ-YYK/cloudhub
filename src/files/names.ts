export type NameProblem = 'empty' | 'too_long' | 'invalid_chars'

export type NameCheck =
  | { ok: true; normalized: string }
  | { ok: false; normalized: string; problem: NameProblem; length: number }

const NAME_MAX_LENGTH = 255
const INVALID_NAME_CHARS = /[/\\\p{Cc}]/u

export function checkName(name: string): NameCheck {
  const normalized = name.normalize('NFC').trim()
  const length = [...normalized].length
  if (length === 0) return { ok: false, normalized, problem: 'empty', length }
  if (length > NAME_MAX_LENGTH) return { ok: false, normalized, problem: 'too_long', length }
  if (INVALID_NAME_CHARS.test(normalized)) return { ok: false, normalized, problem: 'invalid_chars', length }
  return { ok: true, normalized }
}

export function normalizeName(name: string): string {
  return name.normalize('NFC').trim()
}

export function nameProblemMessage(problem: NameProblem, length: number): string {
  if (problem === 'empty') return '名字不能为空'
  if (problem === 'too_long') return `名字太长：最多 255 个字符，现在是 ${length} 个`
  return '名字不能包含 / \\ 或控制字符'
}

export function sanitizeDisplayName(name: string, kind: 'file' | 'directory'): string {
  const normalized = name.normalize('NFC').trim()
  const hasReplacement = normalized.includes('�')
  const hasControl = [...normalized].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || code === 0x7f
  })
  if (!normalized || hasReplacement || hasControl) {
    return kind === 'directory' ? '未命名文件夹' : '未命名文件'
  }
  return normalized
}
