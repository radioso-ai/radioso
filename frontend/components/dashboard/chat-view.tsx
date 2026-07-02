'use client'

import { ChatWorkbench, type ChatWorkbenchProps } from '@/components/dashboard/workbench/chat-workbench'

export type ChatViewProps = ChatWorkbenchProps

/**
 * Dashboard test chat. Thin alias over {@link ChatWorkbench}, which owns the
 * layout so the same workbench (chat + copyable conversation id + selectable
 * turn inspector) can also be mounted inside a drawer elsewhere.
 */
export function ChatView(props: ChatViewProps) {
  return <ChatWorkbench {...props} />
}
