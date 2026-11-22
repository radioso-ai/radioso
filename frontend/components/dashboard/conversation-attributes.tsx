'use client'

import { useCallback, useState } from 'react'

import { AttributeRowMenu, SetAttributeMenu } from '@/components/dashboard/conversation-attribute-edit-menus'
import { useInboxAttributeOptions } from '@/components/dashboard/inbox/use-inbox-attribute-options'
import { attributeEditCopy, attributeValueText, attributeWrittenText } from '@/components/dashboard/settings/attribute-copy'
import { Button } from '@/components/ui/button'
import { chatApi } from '@/lib/api'
import type { ConversationAttribute } from '@/lib/api-types'
import { attributeResetAction, settableOptions, unsetAttributeChoices } from '@/lib/conversation-attribute-edits'
import { previewAttributeValue } from '@/lib/conversation-attributes'

const timestampFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** What a teammate who may edit the conversation's attributes hands the block. */
export interface ConversationAttributeEditing {
  workspaceId: string
  conversationId: string
  /** The edit's result, as the conversation now reads the attribute; null when nothing holds it. */
  onChange: (name: string, changed: ConversationAttribute | null) => void
}

/** Editing for a conversation detail that says the signed-in teammate may edit its attributes; null otherwise. */
export const attributeEditingFor = (
  detail: { workspaceId: string; conversationId: string; attributesEditable?: boolean } | null | undefined,
  onChange: ConversationAttributeEditing['onChange'],
): ConversationAttributeEditing | null =>
  detail?.attributesEditable ? { workspaceId: detail.workspaceId, conversationId: detail.conversationId, onChange } : null

/**
 * A conversation's attributes: each value, who set it and when. With `editing`, a teammate sets a
 * Choice attribute's option for the conversation and undoes their own value. Without it, or for a
 * conversation with no attributes and nothing to set, it is read-only or renders nothing.
 */
export function ConversationAttributes({
  attributes,
  editing,
  className,
}: {
  attributes: readonly ConversationAttribute[] | undefined
  editing?: ConversationAttributeEditing | null
  className?: string
}) {
  const catalog = useInboxAttributeOptions({ workspaceId: editing?.workspaceId ?? '', enabled: Boolean(editing) })
  const editor = useAttributeEditor(editing ?? null)
  const unset = editing ? unsetAttributeChoices(catalog.choices, attributes) : []
  if (!attributes?.length && unset.length === 0) return null

  return (
    <section aria-label="Attributes" className={className}>
      <div className="rounded-lg border border-border/70 bg-background/70 p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-foreground">Attributes</p>
          <SetAttributeMenu attributes={unset} disabled={editor.busy} onSet={(name, key) => editor.run(name, key)} />
        </div>
        <dl className="mt-2 grid gap-x-4 gap-y-3 sm:grid-cols-2">
          {(attributes ?? []).map((attribute) => {
            const options = editing ? settableOptions(catalog.choices, attribute) : []
            return (
              <div key={attribute.name} className="min-w-0">
                <dt className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
                  {attribute.name}
                  {options.length > 0 ? (
                    <AttributeRowMenu
                      attribute={attribute}
                      options={options}
                      resetAction={attributeResetAction(attribute)}
                      disabled={editor.busy}
                      onSet={(key) => editor.run(attribute.name, key)}
                      onReset={() => editor.run(attribute.name, null)}
                    />
                  ) : null}
                </dt>
                <dd className="mt-0.5 break-words text-sm text-foreground">
                  <AttributeValue attribute={attribute} />
                  {attribute.option?.archived ? <span className="text-muted-foreground"> (archived)</span> : null}
                </dd>
                <dd className="text-xs text-muted-foreground">
                  {attributeWrittenText(attribute)} · {timestampFormatter.format(new Date(attribute.updatedAt))}
                </dd>
              </div>
            )
          })}
        </dl>
        {editor.failed ? <p role="alert" className="mt-2 text-xs text-destructive">{attributeEditCopy.failed}</p> : null}
      </div>
    </section>
  )
}

/** Runs one edit at a time and hands its result to the caller; a failure leaves the attributes as they were. */
function useAttributeEditor(editing: ConversationAttributeEditing | null) {
  const [busy, setBusy] = useState(false)
  const [failedFor, setFailedFor] = useState<string | null>(null)
  const conversationId = editing?.conversationId ?? null
  const onChange = editing?.onChange

  const run = useCallback(async (name: string, key: string | null) => {
    if (!conversationId || !onChange) return
    setBusy(true)
    setFailedFor(null)
    try {
      const change = key === null
        ? await chatApi.resetHistoryConversationAttribute(conversationId, name)
        : await chatApi.setHistoryConversationAttribute(conversationId, name, key)
      onChange(name, change.attribute ?? null)
    } catch {
      setFailedFor(conversationId)
    } finally {
      setBusy(false)
    }
  }, [conversationId, onChange])

  return { busy, failed: failedFor !== null && failedFor === conversationId, run: (name: string, key: string | null) => void run(name, key) }
}

/** The value, cut to a preview when long, with a toggle to read it whole. */
function AttributeValue({ attribute }: { attribute: ConversationAttribute }) {
  const [expanded, setExpanded] = useState(false)
  const text = attributeValueText(attribute)
  const preview = previewAttributeValue(text)
  return (
    <>
      <span className={attribute.redacted ? 'text-muted-foreground' : undefined}>{expanded ? text : preview.text}</span>
      {preview.truncated ? (
        <Button variant="link" size="sm" className="ml-1 h-auto p-0 text-xs" onClick={() => setExpanded((current) => !current)}>
          {expanded ? 'Show less' : 'Show all'}
        </Button>
      ) : null}
    </>
  )
}
