import { parseIndentedBlocks, renderNestedMarkdownContent, type JSONContent, type MarkdownLexerConfiguration } from '@tiptap/core'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'

// "- [>] " is a task moved to another day, as in bullet journals and Obsidian.
const ITEM = /^(\s*)([-+*])\s+\[([ xX>])\]\s+(.*)$/

/** The stock task list tokenizer, also accepting "[>]". */
function tokenizeTaskList(src: string, lexer: MarkdownLexerConfiguration) {
  const result = parseIndentedBlocks(
    src,
    {
      itemPattern: ITEM,
      extractItemData: (match) => ({ indentLevel: match[1].length, mainContent: match[4], mark: match[3] }),
      createToken: (data, nestedTokens) => ({
        type: 'taskItem',
        raw: '',
        mainContent: data.mainContent,
        indentLevel: data.indentLevel,
        checked: data.mark === 'x' || data.mark === 'X',
        moved: data.mark === '>',
        text: data.mainContent,
        tokens: lexer.inlineTokens(data.mainContent),
        nestedTokens,
      }),
      customNestedParser: (content) => {
        const nested = tokenizeTaskList(content, lexer)
        if (!nested) return lexer.blockTokens(content)
        const rest = content.slice(nested.raw.length)
        return rest.trim() ? [nested, ...lexer.blockTokens(rest)] : [nested]
      },
    },
    lexer,
  )
  return result && { type: 'taskList', raw: result.raw, items: result.items }
}

export const Tasks = TaskList.extend({
  markdownTokenizer: {
    name: 'taskList',
    level: 'block',
    start: (src) => src.match(/^\s*[-+*]\s+\[[ xX>]\]\s+/)?.index ?? -1,
    tokenize: (src, _tokens, lexer) => tokenizeTaskList(src, lexer),
  },
})

/** A task item that can also be moved: it shows an arrow instead of a checkbox, and clicking it reopens the task. */
export const Task = TaskItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      moved: {
        default: false,
        keepOnSplit: false,
        parseHTML: (element) => element.hasAttribute('data-moved'),
        renderHTML: (attributes) => (attributes.moved ? { 'data-moved': '' } : {}),
      },
    }
  },
  parseMarkdown: (token, h) => {
    const content: JSONContent[] = [h.createNode('paragraph', {}, token.tokens?.length ? h.parseInline(token.tokens) : [])]
    if (token.nestedTokens?.length) content.push(...h.parseChildren(token.nestedTokens))
    return h.createNode('taskItem', { checked: token.checked ?? false, moved: token.moved ?? false }, content)
  },
  renderMarkdown: (node, h) => renderNestedMarkdownContent(node, h, `- [${node.attrs?.moved ? '>' : node.attrs?.checked ? 'x' : ' '}] `),
  addNodeView() {
    const stock = this.parent?.()
    if (!stock) return null
    return (props) => {
      const view = stock(props)
      const label = (view.dom as HTMLElement).querySelector('label')!
      let node = props.node
      const show = () => (label.title = node.attrs.moved ? 'Moved' : '')
      show()
      label.querySelector('input')!.addEventListener('click', (event) => {
        if (!node.attrs.moved) return
        event.preventDefault()
        const pos = props.getPos()
        if (!props.editor.isEditable || typeof pos !== 'number') return
        props.editor.view.dispatch(props.editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, moved: false, checked: false }))
      })
      return {
        ...view,
        update: (updated, decorations, inner) => {
          if (!view.update?.(updated, decorations, inner)) return false
          node = updated
          show()
          return true
        },
      }
    }
  },
}).configure({ nested: true })
