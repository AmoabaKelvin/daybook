import { AnimatePresence } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { hideQuick, quickAdd, resizeQuick } from '../lib/api'
import { onQuickPanel } from '../lib/native'
import { toTaskBlock } from '../lib/tasks'
import { CaptureCard } from './Capture'

/** The page inside the quick capture panel: just the capture box, which the panel fits around. */
export function QuickCapture() {
  const [open, setOpen] = useState(false)
  const [session, setSession] = useState(0)
  const isOpen = useRef(false)
  const frame = useRef<HTMLDivElement>(null)

  useEffect(
    () =>
      onQuickPanel((next) => {
        isOpen.current = next
        setOpen(next)
        if (next) setSession((s) => s + 1)
      }),
    [],
  )

  useEffect(() => {
    const el = frame.current
    if (!el) return
    const observer = new ResizeObserver(() => resizeQuick(Math.ceil(el.getBoundingClientRect().height)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  function close() {
    isOpen.current = false
    setOpen(false)
  }

  async function submit(text: string, subtasks: string[], target: string) {
    await quickAdd(target, await toTaskBlock(text, subtasks))
  }

  return (
    <div ref={frame} className="quick-frame">
      <AnimatePresence onExitComplete={() => !isOpen.current && hideQuick()}>
        {open && <CaptureCard key={session} onClose={close} onSubmit={submit} />}
      </AnimatePresence>
    </div>
  )
}
