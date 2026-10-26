import type { Editor } from '@tiptap/core'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { Placeholder } from '@tiptap/extensions'
import { Markdown } from '@tiptap/markdown'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { memo, useEffect, useRef } from 'react'
import { tidyMarkdown } from '../lib/tasks'
import { BulletToTask, handleClick, handlePaste, LinkState, Settle, SmartLink } from '../lib/extensions'

type Props = {
  initial: string
  placeholder: string
  onChange: (markdown: string) => void
  onReady: (editor: Editor | null) => void
}

export const NoteEditor = memo(function NoteEditor({ initial, placeholder, onChange, onReady }: Props) {
  // React's StrictMode can build a spare editor that is never shown; only the live one may save.
  const live = useRef<Editor | null>(null)
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: false, heading: { levels: [1, 2, 3] } }),
      SmartLink,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder, showOnlyCurrent: true }),
      Markdown,
      LinkState,
      BulletToTask,
      Settle,
    ],
    content: initial,
    contentType: 'markdown',
    autofocus: 'end',
    editorProps: { handlePaste, handleClick, attributes: { class: 'prose', spellcheck: 'true' } },
    onUpdate: ({ editor }) => {
      if (editor === live.current) onChange(tidyMarkdown(editor.getMarkdown()))
    },
  })

  useEffect(() => {
    live.current = editor
    onReady(editor)
    return () => onReady(null)
  }, [editor, onReady])

  return <EditorContent editor={editor} />
})
