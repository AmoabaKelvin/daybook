export const BACKLOG = 'backlog'

export function dayId(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function parseDay(id: string) {
  const [y, m, d] = id.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function isDay(id: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(id)
}

function daysAgo(id: string) {
  const today = parseDay(dayId())
  return Math.round((today.getTime() - parseDay(id).getTime()) / 86_400_000)
}

export function shortLabel(id: string) {
  if (id === BACKLOG) return 'Backlog'
  const ago = daysAgo(id)
  if (ago === 0) return 'Today'
  if (ago === 1) return 'Yesterday'
  const date = parseDay(id)
  if (ago > 1 && ago < 7) return date.toLocaleDateString(undefined, { weekday: 'long' })
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  })
}

export function titleFor(id: string) {
  if (id === BACKLOG) return { title: 'Backlog', subtitle: 'Someday, not today' }
  const date = parseDay(id)
  const ago = daysAgo(id)
  const weekday = date.toLocaleDateString(undefined, { weekday: 'long' })
  return {
    title: ago === 0 ? 'Today' : ago === 1 ? 'Yesterday' : weekday,
    subtitle: date.toLocaleDateString(undefined, {
      weekday: ago <= 1 ? 'long' : undefined,
      month: 'long',
      day: 'numeric',
      year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    }),
  }
}
