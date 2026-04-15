'use client'

import { useParams } from 'next/navigation'

import { PublicChatShell } from '@/components/chat/public-chat-shell'

export default function PublicChatPage() {
  const params = useParams()
  const token = params.token as string

  return <PublicChatShell token={token} />
}
