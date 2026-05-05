'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { Mail, Send, UserRound } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  humanContactApi,
  publicChatApi,
  type HumanContactDraftResponse,
  type HumanContactTriggerSource,
} from '@/lib/api'
import type { WebsiteEmbedTheme } from '@/lib/embed-widget'

export interface HumanContactInlineRequest {
  conversationId: string
  assistantMessageId?: string
  triggerSource: HumanContactTriggerSource
  triggerReason?: string
}

export function HumanContactInlineComposer({
  request,
  publicChatToken,
  onCancel,
  onSubmitted,
  theme,
  compact = false,
}: {
  request: HumanContactInlineRequest
  publicChatToken?: string
  onCancel: () => void
  onSubmitted: (message: string) => void
  theme?: WebsiteEmbedTheme | null
  compact?: boolean
}) {
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [isDrafting, setIsDrafting] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Opening handoff mode resets stale draft state before loading the current conversation draft.
    setEmail('')
    setMessage('')
    setError(null)
    setIsDrafting(true)

    const loadDraft = async () => {
      try {
        const draftInput = {
          conversationId: request.conversationId,
          assistantMessageId: request.assistantMessageId,
        }
        const draft: HumanContactDraftResponse = publicChatToken
          ? await publicChatApi.draftHumanContact(publicChatToken, draftInput)
          : await humanContactApi.draft(draftInput)

        if (!active) return
        setEmail(draft.defaultEmail ?? '')
        setMessage(draft.draftMessage)
      } catch (draftError) {
        if (!active) return
        setError(getApiErrorMessage(draftError, 'Could not prepare a contact request.'))
      } finally {
        if (active) {
          setIsDrafting(false)
        }
      }
    }

    void loadDraft()

    return () => {
      active = false
    }
  }, [publicChatToken, request])

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (isDrafting || isSubmitting || !email.trim() || !message.trim()) {
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      const payload = {
        conversationId: request.conversationId,
        assistantMessageId: request.assistantMessageId,
        email: email.trim(),
        message: message.trim(),
        triggerSource: request.triggerSource,
        triggerReason: request.triggerReason,
      }
      await (publicChatToken
        ? publicChatApi.submitHumanContact(publicChatToken, payload)
        : humanContactApi.submit(payload))

      onSubmitted('Sent. Someone from the team will follow up using the email you provided.')
    } catch (submitError) {
      setError(getApiErrorMessage(submitError, 'Could not send the contact request.'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const fieldStyle = theme
    ? {
        background: theme.inputBackground,
        borderColor: theme.inputBorder,
        color: theme.inputForeground,
      }
    : undefined

  return (
    <form onSubmit={handleSubmit} className={`mx-auto flex max-w-3xl flex-col ${compact ? 'gap-2' : 'gap-3'}`}>
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em]" style={theme ? { color: theme.mutedForeground } : undefined}>
        <UserRound className="h-3.5 w-3.5" />
        Contact the team
      </div>

      <div className={`grid gap-2 ${compact ? '' : 'sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]'}`}>
        <div className="space-y-1">
          <Label htmlFor="human-contact-inline-email" className="sr-only">Email</Label>
          <div className="relative">
            <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="human-contact-inline-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="pl-9"
              style={fieldStyle}
              placeholder="Your email"
              autoComplete="email"
              disabled={isDrafting || isSubmitting}
              required
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="human-contact-inline-message" className="sr-only">Message</Label>
          <Textarea
            id="human-contact-inline-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            className={`${compact ? 'min-h-24 max-h-32' : 'min-h-20 max-h-36'} resize-none`}
            style={fieldStyle}
            placeholder="What would you like to ask?"
            disabled={isDrafting || isSubmitting}
            required
          />
        </div>
      </div>

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={isDrafting || isSubmitting || !email.trim() || !message.trim()}>
          {isDrafting || isSubmitting ? <Spinner className="mr-2 h-4 w-4" /> : <Send className="mr-2 h-4 w-4" />}
          Send
        </Button>
      </div>
    </form>
  )
}
