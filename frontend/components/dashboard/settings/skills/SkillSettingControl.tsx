'use client'

import { useState } from 'react'
import { RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'


import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { AssistantSourceScopeSelector } from '@/components/dashboard/settings/assistant-source-scope-selector'
import { MetadataRulesEditor } from '@/components/dashboard/settings/metadata-rules-editor'
import type {
  AgentSourceScope,
  DocumentSourceListItem,
  MetadataFieldSuggestion,
  RetrievalMetadataRule,
} from '@/lib/api'
import type { NotificationRecipient } from '@/lib/operator-notice-destinations'
import type { SkillCapabilityDescriptor, SkillCapabilitySettingsField } from '@/lib/api-skills'
import { cn } from '@/lib/utils'
import {
  resolveUsageCapNotice,
  type SkillFormDraft,
  type SkillSettingDraftValue,
} from './skill-form-model'

const isSourceScopeDraft = (value: SkillSettingDraftValue): value is AgentSourceScope =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value) && 'mode' in value

export const sourceTargetsToList = (capability: SkillCapabilityDescriptor | null): DocumentSourceListItem[] =>
  (capability?.targets ?? [])
    .filter((target) => target.id !== 'all')
    .map((target) => ({
      id: target.id,
      name: target.label,
      kind: 'upload',
      externalId: null,
      lastSyncStatus: target.status ?? null,
      lastSyncedAt: null,
      documentCount: 0,
      documentEnrichmentOverride: 'inherit',
      documentMetadata: {},
      createdAt: '',
      updatedAt: '',
    }))

export const groupedSettingsFields = (fields: readonly SkillCapabilitySettingsField[]) => {
  const groups = new Map<string, SkillCapabilitySettingsField[]>()
  for (const field of fields) {
    const group = field.group ?? 'Settings'
    groups.set(group, [...(groups.get(group) ?? []), field])
  }
  return [...groups.entries()]
}

const DEFAULT_SELECT_VALUE = '__default__'

export const preserveInputDrafts = (
  nextDrafts: SkillFormDraft['inputDrafts'],
  currentDrafts: SkillFormDraft['inputDrafts'],
): SkillFormDraft['inputDrafts'] =>
  Object.fromEntries(
    Object.entries(nextDrafts).map(([name, nextDraft]) => [name, currentDrafts[name] ?? nextDraft]),
  )

const optionLabel = (field: SkillCapabilitySettingsField, value: unknown): string | null =>
  typeof value === 'string'
    ? field.options?.find((option) => option.value === value)?.label ?? value
    : null

const formatDefaultValue = (field: SkillCapabilitySettingsField): string | null => {
  if (field.defaultValue === undefined) return null
  if (field.type === 'select') return optionLabel(field, field.defaultValue)
  if (typeof field.defaultValue === 'boolean') return field.defaultValue ? 'On' : 'Off'
  return String(field.defaultValue)
}

const isParentEffectivelyEnabled = (
  parent: SkillCapabilitySettingsField | undefined,
  settingDrafts: Record<string, SkillSettingDraftValue>,
): boolean => {
  if (!parent || parent.type !== 'boolean') return false
  const value = settingDrafts[parent.key]
  return typeof value === 'boolean' ? value : parent.defaultValue === true
}

export const visibleSettingRows = (
  fields: readonly SkillCapabilitySettingsField[],
  settingDrafts: Record<string, SkillSettingDraftValue>,
): Array<{ field: SkillCapabilitySettingsField; nested: boolean }> => {
  const byKey = new Map(fields.map((field) => [field.key, field]))
  const childrenByParent = new Map<string, SkillCapabilitySettingsField[]>()
  const childKeys = new Set<string>()

  for (const field of fields) {
    if (!field.dependsOnKey) continue
    childKeys.add(field.key)
    childrenByParent.set(field.dependsOnKey, [...(childrenByParent.get(field.dependsOnKey) ?? []), field])
  }

  const rows: Array<{ field: SkillCapabilitySettingsField; nested: boolean }> = []
  for (const field of fields) {
    if (childKeys.has(field.key)) continue
    rows.push({ field, nested: false })
    if (!isParentEffectivelyEnabled(field, settingDrafts)) continue
    for (const child of childrenByParent.get(field.key) ?? []) {
      rows.push({ field: child, nested: true })
    }
  }

  for (const field of fields) {
    if (!field.dependsOnKey || byKey.has(field.dependsOnKey)) continue
    rows.push({ field, nested: false })
  }

  return rows
}

export const shouldShowGroupHeading = (
  group: string,
  fields: readonly SkillCapabilitySettingsField[],
): boolean =>
  !(fields.length === 1 && fields[0]?.type === 'boolean' && fields[0].label === group)

export type RecipientState = NotificationRecipient['state']

const RECIPIENT_STATE_LABELS: Record<Exclude<RecipientState, 'confirmation_not_required'>, string> = {
  confirmed: 'Confirmed',
  grandfathered: 'Confirmation grace period',
  waiting_for_confirmation: 'Waiting for confirmation',
  revoked: 'Notifications stopped by the recipient',
  suppressed: 'Suppressed after a bounce or complaint',
}

function RecipientConfirmationStatus({ email, state, onResend }: {
  email: string
  state: RecipientState
  onResend?: (email: string) => Promise<string>
}) {
  const [resendResult, setResendResult] = useState<string | null>(null)
  if (state === 'confirmation_not_required') return null
  const canResend = (state === 'waiting_for_confirmation' || state === 'grandfathered') && onResend
  return (
    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{RECIPIENT_STATE_LABELS[state]}</span>
      {resendResult ? <span>{resendResult}</span> : canResend ? (
        <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={() => void onResend(email).then(setResendResult)}>
          <RefreshCw className="mr-1 h-3 w-3" /> Resend confirmation
        </Button>
      ) : null}
    </div>
  )
}

export function SkillSettingControl({
  field,
  value,
  allFields,
  settingDrafts,
  sourceList,
  metadataFieldSuggestions,
  onChange,
  recipientStates,
  onResendConfirmation,
}: {
  field: SkillCapabilitySettingsField
  value: SkillSettingDraftValue
  allFields: readonly SkillCapabilitySettingsField[]
  settingDrafts: Record<string, SkillSettingDraftValue>
  sourceList: DocumentSourceListItem[]
  metadataFieldSuggestions: MetadataFieldSuggestion[]
  onChange: (value: SkillSettingDraftValue) => void
  recipientStates?: Map<string, RecipientState>
  onResendConfirmation?: (email: string) => Promise<string>
}) {
  const fieldId = `skill-setting-${field.key.replace(/[^a-z0-9_-]/giu, '-')}`
  const defaultValue = formatDefaultValue(field)

  if (field.type === 'source_scope') {
    return (
      <div className="md:col-span-2">
        <AssistantSourceScopeSelector
          sourceScope={isSourceScopeDraft(value) ? value : { mode: 'all' }}
          sourceList={sourceList}
          onChange={onChange}
        />
      </div>
    )
  }

  if (field.type === 'boolean') {
    const hasOverride = typeof value === 'boolean'
    const hasWorkspaceDefault = field.defaultValue !== undefined
    return (
      <div className="flex items-center justify-between gap-3 rounded-md bg-muted/20 px-3 py-2">
        <div className="space-y-1">
          <Label htmlFor={fieldId}>{field.label}</Label>
          {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
          {!hasOverride && hasWorkspaceDefault ? (
            <p className="text-xs text-muted-foreground">Workspace default: {defaultValue}</p>
          ) : null}
          {!hasOverride && hasWorkspaceDefault ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Override ${field.label}`}
              onClick={() => onChange(field.defaultValue === true)}
            >
              Override
            </Button>
          ) : null}
          {hasOverride && hasWorkspaceDefault ? (
            <Button
              type="button"
              variant="link"
              className="h-auto p-0 text-xs text-muted-foreground"
              aria-label={`Reset ${field.label} to workspace default`}
              onClick={() => onChange(undefined)}
            >
              Reset to workspace default
            </Button>
          ) : null}
        </div>
        <Switch
          id={fieldId}
          checked={hasOverride ? value : field.defaultValue === true}
          disabled={!hasOverride && hasWorkspaceDefault}
          onCheckedChange={onChange}
        />
      </div>
    )
  }

  if (field.type === 'select') {
    const selectedDefaultLabel = optionLabel(field, field.defaultValue)
    const selectValue = typeof value === 'string' ? value : DEFAULT_SELECT_VALUE
    return (
      <div className="space-y-2">
        <Label htmlFor={fieldId}>{field.label}</Label>
        <Select
          value={selectValue}
          onValueChange={(nextValue) => onChange(nextValue === DEFAULT_SELECT_VALUE ? undefined : nextValue)}
        >
          <SelectTrigger id={fieldId}>
            <SelectValue placeholder={selectedDefaultLabel ? `Default (${selectedDefaultLabel})` : 'Choose option'}>
              {selectValue === DEFAULT_SELECT_VALUE
                ? selectedDefaultLabel ? `Default (${selectedDefaultLabel})` : 'Choose option'
                : undefined}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_SELECT_VALUE}>
              {selectedDefaultLabel ? `Use default (${selectedDefaultLabel})` : 'Choose option'}
            </SelectItem>
            {(field.options ?? []).map((option) => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
      </div>
    )
  }

  if (field.type === 'textarea') {
    const defaultText = typeof field.defaultValue === 'string' ? field.defaultValue : null
    const hasOverride = typeof value === 'string'
    const tallDefault = defaultText !== null && defaultText.length > 200

    if (defaultText !== null && !hasOverride) {
      return (
        <div className="space-y-2 md:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={fieldId}>{field.label}</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Override ${field.label}`}
              onClick={() => onChange(defaultText)}
            >
              Override
            </Button>
          </div>
          <Textarea
            id={fieldId}
            value={defaultText}
            disabled
            className={cn('min-h-24', tallDefault ? 'min-h-56' : '')}
          />
          <p className="text-xs text-muted-foreground">Workspace default shown. Override to edit it for this skill.</p>
          {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
        </div>
      )
    }

    return (
      <div className="space-y-2 md:col-span-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={fieldId}>{field.label}</Label>
          {defaultText !== null ? (
            <Button
              type="button"
              variant="link"
              className="h-auto p-0 text-xs text-muted-foreground"
              aria-label={`Reset ${field.label} to workspace default`}
              onClick={() => onChange(undefined)}
            >
              Reset to workspace default
            </Button>
          ) : null}
        </div>
        <Textarea
          id={fieldId}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
          className={cn('min-h-24', tallDefault ? 'min-h-56' : '')}
        />
        {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
      </div>
    )
  }

  if (field.type === 'string_list') {
    const items = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
    const updateItem = (index: number, nextValue: string) => {
      const next = [...items]
      next[index] = nextValue
      onChange(next)
    }
    const removeItem = (index: number) => {
      onChange(items.filter((_, itemIndex) => itemIndex !== index))
    }
    return (
      <div className="space-y-2 md:col-span-2">
        <Label>{field.label}</Label>
        <div className="space-y-2">
          {[...items, ''].map((item, index) => (
            <div key={index} className="space-y-1">
              <div className="flex gap-2">
                <Input
                  value={item}
                  onChange={(event) => updateItem(index, event.target.value)}
                  placeholder="name@example.com"
                  aria-label={`${field.label} ${index + 1}`}
                />
                {index < items.length ? (
                  <Button type="button" variant="outline" onClick={() => removeItem(index)}>
                    Remove
                  </Button>
                ) : null}
              </div>
              {index < items.length && recipientStates?.get(item.trim().toLowerCase()) ? (
                <RecipientConfirmationStatus
                  email={item}
                  state={recipientStates.get(item.trim().toLowerCase())!}
                  onResend={onResendConfirmation}
                />
              ) : null}
            </div>
          ))}
        </div>
        {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
      </div>
    )
  }

  if (field.type === 'metadata_rules') {
    const rules = Array.isArray(value) ? (value as RetrievalMetadataRule[]) : []
    return (
      <div className="space-y-2 md:col-span-2">
        <Label>{field.label}</Label>
        {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
        <MetadataRulesEditor
          metadataRules={rules}
          metadataFieldSuggestions={metadataFieldSuggestions}
          onChange={(next) => onChange(next)}
          showHeader={false}
        />
      </div>
    )
  }

  const defaultNumber = field.type === 'number' && typeof field.defaultValue === 'number'
    ? field.defaultValue
    : null
  const hasNumberOverride = field.type === 'number' && typeof value === 'number'

  if (defaultNumber !== null && !hasNumberOverride) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={fieldId}>{field.label}</Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Override ${field.label}`}
            onClick={() => onChange(defaultNumber)}
          >
            Override
          </Button>
        </div>
        <Input id={fieldId} type="number" min={field.min} max={field.max} value={String(defaultNumber)} disabled />
        <p className="text-xs text-muted-foreground">Workspace default shown. Override to edit it for this skill.</p>
        {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={fieldId}>{field.label}</Label>
        {defaultNumber !== null ? (
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-xs text-muted-foreground"
            aria-label={`Reset ${field.label} to workspace default`}
            onClick={() => onChange(undefined)}
          >
            Reset to workspace default
          </Button>
        ) : null}
      </div>
      <Input
        id={fieldId}
        type={field.type === 'number' ? 'number' : 'text'}
        min={field.min}
        max={field.max}
        placeholder={field.type === 'number' && field.defaultValue !== undefined ? `Workspace default: ${field.defaultValue}` : undefined}
        value={field.type === 'number'
          ? typeof value === 'number' ? String(value) : ''
          : typeof value === 'string' ? value : ''}
        onChange={(event) => {
          if (field.type === 'number') {
            onChange(event.target.value === '' ? undefined : Number(event.target.value))
            return
          }
          onChange(event.target.value)
        }}
      />
      {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
      {field.type === 'number' && field.usageCap ? (() => {
        const notice = resolveUsageCapNotice(field, allFields, settingDrafts)
        return notice ? <p className="text-xs text-amber-700">{notice}</p> : null
      })() : null}
    </div>
  )
}
