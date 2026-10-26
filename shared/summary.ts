export type NoteSummary = {
  id: string
  open: number
  done: number
  preview: string
  updated: number
}

const TASK = /^\s*[-*+] \[( |x|X)\] /

export function summarize(id: string, markdown: string, updated = Date.now()): NoteSummary {
  let open = 0
  let done = 0
  let preview = ''
  for (const line of markdown.split('\n')) {
    const task = line.match(TASK)
    if (task && task[1] === ' ') open++
    else if (task) done++
    if (!preview && line.trim() && !line.startsWith('#')) {
      preview = line
        .replace(TASK, '')
        .replace(/^\s*([-*+>]|\d+\.)\s+/, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`~]/g, '')
        .trim()
        .slice(0, 80)
    }
  }
  return { id, open, done, preview, updated }
}
