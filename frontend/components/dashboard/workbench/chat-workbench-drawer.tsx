'use client'

import { Sheet, SheetContent } from '@/components/ui/sheet'
import { ChatWorkbench, type ChatWorkbenchProps } from '@/components/dashboard/workbench/chat-workbench'

export interface ChatWorkbenchDrawerProps extends Omit<ChatWorkbenchProps, 'shell'> {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Hosts the reusable {@link ChatWorkbench} inside a right-side sliding drawer. Same
 * live chat, streaming, and turn inspector as the full-page workbench — just in a
 * sheet, so a routine author can test a draft without leaving the editor.
 */
export function ChatWorkbenchDrawer({ open, onOpenChange, ...workbenchProps }: ChatWorkbenchDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[95vw] gap-0 p-0 sm:!max-w-[760px]">
        {open ? <ChatWorkbench shell="drawer" {...workbenchProps} /> : null}
      </SheetContent>
    </Sheet>
  )
}
