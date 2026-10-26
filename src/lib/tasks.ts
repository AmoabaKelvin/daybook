import type { Editor, JSONContent } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { diff3Merge } from 'node-diff3'
import { linkInfo } from './api'
import { isEnrichable, isUrl, labelFor } from './links'

/** Editor output collapses runs of blank lines left by empty paragraphs. */
export function tidyMarkdown(markdown: string) {
  return markdown.replace(/\n{3,}/g, '\n\n').trim()
}

const URLS = /https?:\/\/[^\s<>()]+/g

/** Turns captured text into a markdown task, giving every URL in it a readable label. */
export async function toTaskLine(text: string) {
  const trimmed = text.trim()
  if (isUrl(trimmed)) {
    const info = isEnrichable(trimmed) ? await Promise.race([linkInfo(trimmed), wait(2500)]) : null
    return `- [ ] [${escape(info?.title ?? labelFor(trimmed))}](${trimmed})`
  }
  return `- [ ] ${trimmed.replace(URLS, (url) => `[${escape(labelFor(url))}](${url})`)}`
}

/** A captured task with its sub-tasks nested under it, as one markdown block. */
export async function toTaskBlock(text: string, subtasks: string[]) {
  const lines = await Promise.all([text, ...subtasks.filter((s) => s.trim())].map(toTaskLine))
  return lines.map((line, i) => (i === 0 ? line : `  ${line}`)).join('\n')
}

function wait(ms: number) {
  return new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))
}

function escape(label: string) {
  return label.replace(/([[\]\\])/g, '\\$1')
}

/** Appends markdown tasks to the open editor, joining the last task list when the note ends with one. */
export function appendTasks(editor: Editor, markdown: string) {
  const parsed = editor.markdown?.parse(markdown)
  const blocks: JSONContent[] = parsed?.content ?? []
  if (!blocks.length) return
  const { doc } = editor.state
  const isBlank = (node: PMNode) => node.type.name === 'paragraph' && node.content.size === 0

  // Skip the empty paragraphs the editor keeps at the end, so tasks join the real last block.
  let index = doc.childCount - 1
  while (index > 0 && isBlank(doc.child(index))) index--
  const last = doc.child(index)
  let end = 0
  for (let i = 0; i <= index; i++) end += doc.child(i).nodeSize

  if (last.type.name === 'taskList' && blocks.every((b) => b.type === 'taskList')) {
    editor.chain().insertContentAt(end - 1, blocks.flatMap((b) => b.content ?? [])).run()
  } else if (isBlank(last)) {
    editor.chain().insertContentAt({ from: end - last.nodeSize, to: end }, blocks).run()
  } else {
    editor.chain().insertContentAt(end, blocks).run()
  }
}

/** Appends tasks to a note's markdown, keeping them in the same list as any tasks it ends with. */
export function appendToMarkdown(markdown: string, tasks: string) {
  const body = markdown.trimEnd()
  if (!body) return `${tasks}\n`
  const lastLine = body.split('\n').at(-1) ?? ''
  return `${body}${/^\s*[-*+] \[[ xX]\] /.test(lastLine) ? '\n' : '\n\n'}${tasks}\n`
}

/** The unfinished top-level tasks in a note, with anything nested under them. */
export function openTasks(markdown: string) {
  const kept: string[] = []
  let keeping = false
  for (const line of markdown.split('\n')) {
    if (/^[-*+] \[ \] /.test(line)) keeping = true
    else if (!/^\s+\S/.test(line)) keeping = false
    if (keeping) kept.push(line)
  }
  return kept.join('\n')
}

/**
 * Three-way merge of a note edited in the app (local) and on disk (remote), from the
 * version both started at. Where both changed the same lines, the app's lines win and
 * any lines only the disk had are kept after them, so nothing is dropped.
 */
export function mergeMarkdown(local: string, base: string, remote: string) {
  return diff3Merge(local.split('\n'), base.split('\n'), remote.split('\n'))
    .flatMap((region) => {
      if (region.ok) return region.ok
      const { a, b } = region.conflict!
      return [...a, ...b.filter((line) => !a.includes(line))]
    })
    .join('\n')
}

/** Replaces only the part of the document that differs, so the cursor and undo history survive. */
export function applyMarkdown(editor: Editor, markdown: string) {
  const json = editor.markdown?.parse(markdown)
  if (!json) return
  const { state } = editor
  const next = state.schema.nodeFromJSON(json)
  const start = state.doc.content.findDiffStart(next.content)
  if (start == null) return
  const end = state.doc.content.findDiffEnd(next.content)!
  let { a: endOld, b: endNew } = end
  const overlap = start - Math.min(endOld, endNew)
  if (overlap > 0) {
    endOld += overlap
    endNew += overlap
  }
  editor.view.dispatch(state.tr.replace(start, endOld, next.slice(start, endNew)))
}
