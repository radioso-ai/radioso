'use client'

import { Wrench } from 'lucide-react'

import { linkifyText } from '@/components/dashboard/chat-citations'
import { VisitorImageThumbnails, type VisitorImageThreadConfig } from '@/components/chat/visitor-image-thumbnails'
import type { ChatUserInputMetadata } from '@/lib/api-types'
import { visitorMessageBody } from '@/lib/visitor-image-input'

/**
 * A calling agent's tool call, recorded with its structured form. Renders the tool
 * name and each slot value it supplied; the message content stays the fallback.
 */
const RoutineInvocationBlock = ({
  invocation,
  fallback,
}: {
  invocation: NonNullable<ChatUserInputMetadata['routine']>
  fallback: string
}) => {
  const entries = Object.entries(invocation.input ?? {})
  if (!invocation.toolName) {
    return <p className="select-text whitespace-pre-wrap text-sm">{linkifyText(fallback)}</p>
  }
  return (
    <div className="select-text text-sm" data-testid="routine-invocation-block">
      <div className="flex items-center gap-1.5 font-mono text-xs">
        <Wrench className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{invocation.toolName}</span>
      </div>
      {entries.length > 0 ? (
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {entries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="font-mono text-xs opacity-80">{key}</dt>
              <dd className="break-words">{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  )
}

/**
 * What the visitor's bubble holds: a calling agent's tool call, the visitor's photos with what they
 * typed, or their text. A message with photos shows `typedText` and never `content`, which carries
 * the agent's readings.
 */
export function VisitorMessageBody({
  message,
  imageConfig,
}: {
  message: { content: string; inputMetadata?: ChatUserInputMetadata }
  imageConfig?: VisitorImageThreadConfig
}) {
  if (message.inputMetadata?.method === 'routine_invocation' && message.inputMetadata.routine) {
    return <RoutineInvocationBlock invocation={message.inputMetadata.routine} fallback={message.content} />
  }
  const body = visitorMessageBody(message)
  if (body.kind === 'text') {
    return <p className="select-text whitespace-pre-wrap text-sm">{linkifyText(body.text)}</p>
  }
  return (
    <div className="space-y-2">
      {imageConfig ? <VisitorImageThumbnails images={body.images} config={imageConfig} /> : null}
      {body.typedText ? <p className="select-text whitespace-pre-wrap text-sm">{linkifyText(body.typedText)}</p> : null}
    </div>
  )
}
