export interface ServerTiming {
  mark(name: string): void
  header(): string
}

// Each mark records the time spent since the previous mark; header() appends the total.
export function createServerTiming(now: () => number = Date.now): ServerTiming {
  const start = now()
  let last = start
  const marks: string[] = []

  return {
    mark(name: string) {
      const current = now()
      marks.push(`${name};dur=${Math.max(0, current - last)}`)
      last = current
    },
    header() {
      return [...marks, `total;dur=${Math.max(0, now() - start)}`].join(', ')
    },
  }
}
