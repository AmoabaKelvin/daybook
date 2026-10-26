import { Extension, InputRule, mergeAttributes } from '@tiptap/core'
import Link from '@tiptap/extension-link'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { linkInfo, type LinkInfo } from './api'
import { classify, isEnrichable, isUrl, labelFor } from './links'
import { openLink } from './native'

/** Links render as chips styled by where they point: GitHub, Slack, Linear or the plain web. */
export const SmartLink = Link.extend({
  renderHTML({ HTMLAttributes }) {
    const href = String(HTMLAttributes.href ?? '')
    const info = classify(href)
    const kind = info.kind === 'github' ? `chip-github gh-${info.type}` : `chip-${info.kind}`
    return ['a', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { class: `chip ${kind}`, 'data-ref': info.ref, title: href }), 0]
  },
}).configure({ openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { rel: 'noopener noreferrer', target: null } })

type LinkRange = { from: number; to: number; href: string; text: string }

function linkRanges(doc: PMNode) {
  const ranges: LinkRange[] = []
  doc.descendants((node, pos) => {
    if (!node.isText) return
    const mark = node.marks.find((m) => m.type.name === 'link')
    if (!mark) return
    const href = String(mark.attrs.href)
    const last = ranges.at(-1)
    if (last && last.to === pos && last.href === href) {
      last.to = pos + node.nodeSize
      last.text += node.text
    } else {
      ranges.push({ from: pos, to: pos + node.nodeSize, href, text: node.text ?? '' })
    }
  })
  return ranges
}

const linkStates = new Map<string, LinkInfo | null>()
const linkKey = new PluginKey<DecorationSet>('linkState')

function decorate(doc: PMNode) {
  const decorations = linkRanges(doc).map(({ from, to, href, text }) => {
    const info = classify(href)
    const attrs: Record<string, string> = { class: 'chip-text' }
    if (text.trim() === info.ref) attrs['data-bare'] = ''
    const live = linkStates.get(href)
    if (live) attrs['data-state'] = live.state
    if (live?.status) attrs.title = live.status
    return Decoration.inline(from, to, attrs)
  })
  return DecorationSet.create(doc, decorations)
}

function refresh(view: EditorView) {
  if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(linkKey, true).setMeta('addToHistory', false))
}

function fetchStates(view: EditorView, fresh: boolean) {
  for (const { href } of linkRanges(view.state.doc)) {
    if (!isEnrichable(href) || (!fresh && linkStates.has(href))) continue
    if (!fresh) linkStates.set(href, null)
    linkInfo(href, fresh).then((info) => {
      linkStates.set(href, info)
      refresh(view)
    })
  }
}

/**
 * Marks links so CSS can tell a bare ref ("repo#12") from a titled one, and colours
 * GitHub PRs and issues and Linear issues by their live state.
 */
export const LinkState = Extension.create({
  name: 'linkState',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: linkKey,
        state: {
          init: (_, state) => decorate(state.doc),
          apply: (tr, old) => (tr.docChanged || tr.getMeta(linkKey) ? decorate(tr.doc) : old),
        },
        props: { decorations: (state) => linkKey.getState(state) },
        // A link whose text is just its URL reads better as its short ref.
        appendTransaction(transactions, _old, state) {
          if (!transactions.some((tr) => tr.docChanged || tr.getMeta(linkKey))) return null
          const bare = linkRanges(state.doc).filter((r) => r.text === r.href)
          if (!bare.length) return null
          const { tr, schema, doc } = state
          for (const { from, to, href } of bare.reverse()) {
            tr.replaceWith(from, to, schema.text(labelFor(href), doc.resolve(from + 1).marks()))
          }
          return tr
        },
        view(view) {
          const onFocus = () => fetchStates(view, true)
          window.addEventListener('focus', onFocus)
          setTimeout(() => {
            if (view.isDestroyed) return
            refresh(view)
            titleBareRefs(view)
          })
          return {
            update: (v, prev) => {
              if (v.state.doc.eq(prev.doc)) return
              fetchStates(v, false)
              titleBareRefs(v)
            },
            destroy: () => window.removeEventListener('focus', onFocus),
          }
        },
      }),
    ]
  },
})

const titled = new Set<string>()

/** Forget everything learned about links, e.g. after connecting Linear, so they're looked up again. */
export function forgetLinkStates() {
  linkStates.clear()
  titled.clear()
}

/** Bare PR, issue and Linear refs pick up their title, once per link per session. */
function titleBareRefs(view: EditorView) {
  for (const { href, text } of linkRanges(view.state.doc)) {
    if (titled.has(href) || !isEnrichable(href) || text !== labelFor(href)) continue
    titled.add(href)
    titleLink(view, href, text)
  }
}

/** Swap a placeholder label like "repo#12" or "ENG-42" for the real title once it's known. */
function titleLink(view: EditorView, href: string, placeholder: string) {
  linkInfo(href).then((info) => {
    // A newer editor may still want this title, so let it try.
    if (view.isDestroyed) return titled.delete(href)
    if (!info) return
    linkStates.set(href, info)
    const matches = linkRanges(view.state.doc).filter((r) => r.href === href && r.text === placeholder)
    if (!matches.length) return refresh(view)
    const { tr, schema } = view.state
    for (const { from, to } of matches.reverse()) {
      const marks = view.state.doc.resolve(from + 1).marks()
      tr.replaceWith(from, to, schema.text(info.title, marks))
    }
    view.dispatch(tr.setMeta(linkKey, true))
  })
}

/** A pasted URL becomes a labelled link; pasted over a selection, it links the selection. */
export function handlePaste(view: EditorView, event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text/plain')?.trim()
  if (!text || !isUrl(text)) return false
  const { state } = view
  const link = state.schema.marks.link
  const { from, to, empty, $from } = state.selection
  if ($from.parent.type.spec.code) return false

  if (!empty) {
    view.dispatch(state.tr.addMark(from, to, link.create({ href: text })))
    return true
  }
  const label = labelFor(text)
  const marks = [...$from.marks().filter((m) => m.type !== link), link.create({ href: text })]
  view.dispatch(state.tr.replaceSelectionWith(state.schema.text(label, marks), false).removeStoredMark(link))
  return true
}

/** Links open on click, like they would anywhere else. */
export function handleClick(_view: EditorView, _pos: number, event: MouseEvent) {
  const anchor = (event.target as HTMLElement).closest('a[href]')
  if (!anchor || event.button !== 0) return false
  openLink((anchor as HTMLAnchorElement).href)
  return true
}

/** Typing "[ ] " in a bullet turns the list into a task list, so "- [ ] " works as it does in markdown. */
export const BulletToTask = Extension.create({
  name: 'bulletToTask',
  priority: 200,
  addInputRules() {
    return [
      new InputRule({
        find: /^\[( |x)?\]\s$/,
        handler: ({ state, range, chain, match }) => {
          const $from = state.doc.resolve(range.from)
          if ($from.depth < 2 || $from.node(-1).type.name !== 'listItem') return null
          chain()
            .deleteRange(range)
            .toggleTaskList()
            .command(({ tr }) => {
              if (match[1] === 'x') tr.setNodeAttribute(tr.selection.$from.before(-1), 'checked', true)
              return true
            })
            .run()
        },
      }),
    ]
  },
})

const SETTLES = new Set(['taskItem', 'listItem', 'heading', 'blockquote', 'codeBlock', 'horizontalRule'])
const settleKey = new PluginKey<number[]>('settle')

/**
 * New list items and blocks ease in. Only nodes a transaction actually inserted animate,
 * so redraws (like a PR's state refreshing) never replay it.
 */
export const Settle = Extension.create({
  name: 'settle',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: settleKey,
        state: {
          init: () => [],
          apply(tr) {
            if (!tr.docChanged) return []
            const fresh: number[] = []
            tr.mapping.maps.forEach((map, index) => {
              const rest = tr.mapping.slice(index + 1)
              map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
                if (newEnd <= newStart) return
                const from = rest.map(newStart, -1)
                const to = Math.min(rest.map(newEnd, 1), tr.doc.content.size)
                tr.doc.nodesBetween(from, to, (node, pos) => {
                  if (pos >= from && SETTLES.has(node.type.name)) fresh.push(pos)
                })
              })
            })
            return fresh
          },
        },
        view: () => ({
          update(view) {
            const fresh = settleKey.getState(view.state) ?? []
            fresh.forEach((pos, i) => {
              const dom = view.nodeDOM(pos)
              if (!(dom instanceof HTMLElement) || matchMedia('(prefers-reduced-motion: reduce)').matches) return
              dom.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], {
                duration: 280,
                delay: Math.min(i, 10) * 35,
                easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
                fill: 'backwards',
              })
            })
          },
        }),
      }),
    ]
  },
})
