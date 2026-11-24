export interface ByteRange {
  start: number
  end: number
}

export type ByteRangeResult =
  | { kind: 'range'; start: number; end: number }
  | { kind: 'not-satisfiable' }
  | { kind: 'ignore' }

const BYTES_UNIT = 'bytes='

export function parseByteRange(header: string | null, size: number): ByteRangeResult {
  if (header === null) return { kind: 'ignore' }
  if (!header.startsWith(BYTES_UNIT)) return { kind: 'ignore' }
  const spec = header.slice(BYTES_UNIT.length)
  if (spec.length === 0 || spec.includes(',')) return { kind: 'ignore' }
  if (!/^\d*-\d*$/u.test(spec)) return { kind: 'ignore' }

  const dash = spec.indexOf('-')
  const startText = spec.slice(0, dash)
  const endText = spec.slice(dash + 1)

  if (startText === '') {
    if (endText === '') return { kind: 'ignore' }
    const suffixLength = Number(endText)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: 'ignore' }
    if (size <= 0) return { kind: 'not-satisfiable' }
    return { kind: 'range', start: Math.max(0, size - suffixLength), end: size - 1 }
  }

  const start = Number(startText)
  if (!Number.isSafeInteger(start) || start < 0) return { kind: 'ignore' }

  if (endText === '') {
    if (start >= size) return { kind: 'not-satisfiable' }
    return { kind: 'range', start, end: size - 1 }
  }

  const end = Number(endText)
  if (!Number.isSafeInteger(end) || end < 0) return { kind: 'ignore' }
  if (start > end) return { kind: 'ignore' }
  if (start >= size) return { kind: 'not-satisfiable' }
  return { kind: 'range', start, end: Math.min(end, size - 1) }
}

export function contentRange(start: number, end: number, size: number) {
  return `bytes ${start}-${end}/${size}`
}

export function unsatisfiedContentRange(size: number) {
  return `bytes */${size}`
}
