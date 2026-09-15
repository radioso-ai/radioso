'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-react'

import { AssistantLocaleCombobox } from '@/components/dashboard/settings/assistant-locale-combobox'
import { getAssistantLocaleLabel, resolveAssistantLocaleInput } from '@/components/dashboard/settings/assistant-locale-options'
import { useSettingsSaveStatus, type SettingsSaveStatus } from '@/components/dashboard/settings/use-settings-save-status'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Textarea } from '@/components/ui/textarea'
import { agentGreetingApi } from '@/lib/api-agent-greeting'
import { agentRevisionsApi } from '@/lib/api-agent-revisions'
import { getApiErrorMessage } from '@/lib/api-error'
import type { AgentGreetingDraft, ExactContentItem } from '@/lib/api-types'
import {
  EXACT_GREETING_BODY_MAX_CODE_POINTS,
  EXACT_GREETING_CHIP_LABEL_MAX_CODE_POINTS,
  EXACT_GREETING_MAX_CHIPS,
  addChip,
  addVariant,
  codePointLength,
  createEmptyExactContent,
  extractValidationIssuesFromError,
  issuesForChipLabel,
  issuesForChips,
  issuesForVariantBody,
  issuesForVariantLocale,
  issuesForVariants,
  moveChip,
  removeChip,
  removeVariant,
  updateChipLabel,
  updateVariantBody,
  type ExactGreetingIssue,
} from '@/lib/exact-greeting-editor'

type GreetingWordingMode = 'automatic' | 'exact'

/** Best-effort hydration: there is no endpoint that reads the current, possibly-unpublished
 * draft's greeting content back (spec 1150 F3/F8 project it only into `agent_drafts.snapshot`),
 * so this seeds the editor from the agent's currently published revision, the same "before"
 * value the publish review dialog would show. A draft saved and then reloaded before
 * publishing will not reappear here — the save itself is not lost, only this session's view
 * of it after a reload. */
const loadPublishedGreeting = async (agentId: string): Promise<AgentGreetingDraft | null> => {
  const state = await agentRevisionsApi.getState(agentId)
  if (!state.publishedRevision) {
    return null
  }
  const { revision } = await agentRevisionsApi.getRevision(agentId, state.publishedRevision.id)
  return revision.scopedChanges.greeting?.after ?? null
}

function ChipEditor({
  item,
  variantLocale,
  issues,
  onChange,
}: {
  item: ExactContentItem
  variantLocale: string
  issues: ExactGreetingIssue[]
  onChange: (next: ExactContentItem) => void
}) {
  const variant = item.variants.find((candidate) => candidate.locale === variantLocale)
  if (!variant) {
    return null
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-foreground">Suggestion chips</Label>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={item.chips.length >= EXACT_GREETING_MAX_CHIPS}
          onClick={() => onChange(addChip(item))}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add chip
        </Button>
      </div>
      {issuesForChips(issues).map((issue) => (
        <p key={issue.code} className="text-xs text-destructive">{issue.message}</p>
      ))}
      {item.chips.length === 0 ? (
        <p className="text-xs text-muted-foreground">No chips. Visitors can still reply normally.</p>
      ) : (
        <div className="space-y-2">
          {item.chips.map((chipId, index) => {
            const label = variant.chipLabels[chipId] ?? ''
            const labelIssues = issuesForChipLabel(issues, item.variants.indexOf(variant), chipId)
            return (
              <div key={chipId} className="flex items-start gap-2 rounded-md border border-border p-2">
                <div className="flex shrink-0 flex-col pt-1">
                  <button
                    type="button"
                    aria-label={`Move chip ${index + 1} up`}
                    disabled={index === 0}
                    onClick={() => onChange(moveChip(item, chipId, -1))}
                    className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                  >
                    <ArrowUp className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move chip ${index + 1} down`}
                    disabled={index === item.chips.length - 1}
                    onClick={() => onChange(moveChip(item, chipId, 1))}
                    className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                  >
                    <ArrowDown className="h-3 w-3" />
                  </button>
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <input
                    aria-label={`Chip ${index + 1} label`}
                    value={label}
                    maxLength={EXACT_GREETING_CHIP_LABEL_MAX_CODE_POINTS}
                    onChange={(event) => onChange(updateChipLabel(item, variantLocale, chipId, event.target.value))}
                    placeholder="e.g. Compare plans"
                    className="flex h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm"
                  />
                  {labelIssues.map((issue) => (
                    <p key={issue.code} className="text-xs text-destructive">{issue.message}</p>
                  ))}
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove chip ${index + 1}`}
                  onClick={() => onChange(removeChip(item, chipId))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function VariantEditor({
  item,
  locale,
  isDefault,
  issues,
  onChange,
  onRemove,
}: {
  item: ExactContentItem
  locale: string
  isDefault: boolean
  issues: ExactGreetingIssue[]
  onChange: (next: ExactContentItem) => void
  onRemove: () => void
}) {
  const index = item.variants.findIndex((variant) => variant.locale === locale)
  const variant = item.variants[index]
  const bodyLength = codePointLength(variant.body)

  return (
    <div role="group" aria-label={`Greeting variant: ${getAssistantLocaleLabel(locale)}`} className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline">{getAssistantLocaleLabel(locale)}</Badge>
        {isDefault ? (
          <span className="text-xs text-muted-foreground">Agent default — required</span>
        ) : (
          <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            Remove language
          </Button>
        )}
      </div>
      {issuesForVariantLocale(issues, index).map((issue) => (
        <p key={issue.code} className="text-xs text-destructive">{issue.message}</p>
      ))}
      <div className="space-y-1">
        <Textarea
          aria-label={`Greeting text (${getAssistantLocaleLabel(locale)})`}
          value={variant.body}
          onChange={(event) => onChange(updateVariantBody(item, locale, event.target.value.slice(0, EXACT_GREETING_BODY_MAX_CODE_POINTS)))}
          placeholder="e.g. Welcome to Acme! Ask me anything about your order."
          rows={3}
        />
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Delivered exactly as written — no rewriting, no added intro or closing.</span>
          <span>{bodyLength} / {EXACT_GREETING_BODY_MAX_CODE_POINTS}</span>
        </div>
        {issuesForVariantBody(issues, index).map((issue) => (
          <p key={issue.code} className="text-xs text-destructive">{issue.message}</p>
        ))}
      </div>
      <ChipEditor item={item} variantLocale={locale} issues={issues} onChange={onChange} />
    </div>
  )
}

export function ExactGreetingEditor({
  agentId,
  agentDefaultLocale,
  onSaveStateChange,
}: {
  agentId: string
  agentDefaultLocale: string
  onSaveStateChange?: (input: SettingsSaveStatus) => void
}) {
  const [mode, setMode] = useState<GreetingWordingMode>('automatic')
  const [item, setItem] = useState<ExactContentItem>(() => createEmptyExactContent(agentDefaultLocale))
  const [newLocaleInput, setNewLocaleInput] = useState('')
  const [newLocaleError, setNewLocaleError] = useState<string | null>(null)
  const [issues, setIssues] = useState<ExactGreetingIssue[]>([])
  const [loaded, setLoaded] = useState(false)
  const contentTouchedRef = useRef(false)
  const { saveState, saveError, beginSave, isCurrentSave, markSaved, markError, resetSaveState } = useSettingsSaveStatus(onSaveStateChange)

  useEffect(() => {
    let active = true
    void loadPublishedGreeting(agentId)
      .then((greeting) => {
        if (!active) return
        if (greeting?.exactContent) {
          setItem(greeting.exactContent)
          contentTouchedRef.current = true
        }
        setMode(greeting?.exactWordsEnabled ? 'exact' : 'automatic')
      })
      .catch(() => {
        // Hydration is best-effort; the editor still works starting from a blank draft.
      })
      .finally(() => {
        if (active) setLoaded(true)
      })
    return () => {
      active = false
    }
  }, [agentId])

  const applyItem = (next: ExactContentItem) => {
    contentTouchedRef.current = true
    setItem(next)
    resetSaveState()
  }

  const addLanguage = () => {
    const resolved = resolveAssistantLocaleInput(newLocaleInput)
    if (!resolved) {
      setNewLocaleError(resolved === undefined ? 'Not a recognized language or locale tag.' : 'Choose a language.')
      return
    }
    if (item.variants.some((variant) => variant.locale.toLowerCase() === resolved.toLowerCase())) {
      setNewLocaleError('That language already has a variant.')
      return
    }
    applyItem(addVariant(item, resolved))
    setNewLocaleInput('')
    setNewLocaleError(null)
  }

  const handleSave = async () => {
    const saveId = beginSave()
    setIssues([])
    try {
      const response = await agentGreetingApi.saveDraft(agentId, {
        exactWordsEnabled: mode === 'exact',
        exactContent: mode === 'exact' || contentTouchedRef.current ? item : null,
      })
      if (!isCurrentSave(saveId)) return
      if (!response.validation.ok) {
        setIssues(response.validation.issues ?? [])
      }
      markSaved()
    } catch (error) {
      if (!isCurrentSave(saveId)) return
      const fieldIssues = extractValidationIssuesFromError(error)
      if (fieldIssues) {
        setIssues(fieldIssues)
      }
      markError(getApiErrorMessage(error, 'Failed to save the greeting.'))
    }
  }

  if (!loaded) {
    return <p className="text-sm text-muted-foreground">Loading greeting…</p>
  }

  return (
    <div className="space-y-3">
      <SegmentedControl
        aria-label="Greeting wording"
        value={mode}
        onValueChange={(next) => {
          setMode(next)
          resetSaveState()
        }}
        options={[
          { value: 'automatic', label: 'Automatic' },
          { value: 'exact', label: 'Exact words' },
        ]}
      />
      {mode === 'automatic' ? (
        <p className="text-xs text-muted-foreground">The assistant writes this greeting for every conversation.</p>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Visitors receive this wording exactly as written, with no model call. Goes live on publish.
          </p>
          {issuesForVariants(issues).map((issue) => (
            <p key={issue.code} className="text-xs text-destructive">{issue.message}</p>
          ))}
          {item.variants.map((variant) => (
            <VariantEditor
              key={variant.locale}
              item={item}
              locale={variant.locale}
              isDefault={variant.locale.toLowerCase() === agentDefaultLocale.toLowerCase()}
              issues={issues}
              onChange={applyItem}
              onRemove={() => applyItem(removeVariant(item, variant.locale))}
            />
          ))}
          <div className="space-y-1">
            <Label className="text-foreground">Add a language</Label>
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <AssistantLocaleCombobox
                  id="exactGreetingNewLocale"
                  value={newLocaleInput}
                  onChange={setNewLocaleInput}
                  placeholder="Add a language variant"
                />
              </div>
              <Button type="button" size="sm" variant="outline" onClick={addLanguage} disabled={!newLocaleInput.trim()}>
                Add
              </Button>
            </div>
            {newLocaleError ? <p className="text-xs text-destructive">{newLocaleError}</p> : null}
          </div>
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button type="button" size="sm" onClick={() => void handleSave()} disabled={saveState === 'saving'}>
          {saveState === 'saving' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Save greeting
        </Button>
        {saveState === 'saved' ? <span className="text-xs text-muted-foreground">Saved to draft</span> : null}
      </div>
      {saveState === 'error' && saveError ? <p className="text-sm text-destructive" role="alert">{saveError}</p> : null}
    </div>
  )
}
