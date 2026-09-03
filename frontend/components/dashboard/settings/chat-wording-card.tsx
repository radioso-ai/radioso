'use client'

import { useMemo, useState } from 'react'
import { ChevronDown, Pencil, Plus } from 'lucide-react'

import { BlockHeading } from '@/components/dashboard/settings/block-heading'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { WebsiteEmbedCopyPacks } from '@/lib/api'

/** The locale pack edited by default; also the website widget's last-resort pack. */
export const BASE_COPY_LOCALE = 'en'

const COPY_FIELDS = [
  ['publicChatSubtitle', 'Header subtitle', 'Ask questions and get AI-powered answers'],
  ['publicChatEmptyTitle', 'Empty-state title', 'Start a conversation'],
  ['publicChatEmptyMessage', 'Empty-state message', 'Ask a question and get an AI-powered answer.'],
  ['startPrompt', 'Composer placeholder', 'Ask a question...'],
  ['publicChatNewChatLabel', 'New chat button', 'Clear chat'],
  ['publicChatContactHumanLabel', 'Contact-human button', 'Talk to a human'],
  ['publicChatContactHumanMessage', 'Contact-human message', 'I want to talk to a human.'],
  ['publicChatDisclaimerTemplate', 'Disclaimer', '{name} uses AI and can make mistakes.'],
  ['publicChatAiLabel', 'AI chip', 'AI'],
  ['publicChatOpenFullScreenLabel', 'Full-screen button', 'Open full screen'],
  ['publicChatOpenNewTabLabel', 'New-tab menu item', 'Open in new tab'],
] as const

export interface ChatWordingCardProps {
  copyPacks: NonNullable<WebsiteEmbedCopyPacks>
  /** Owned by the parent because the live preview renders the same pack. */
  activeLocale: string
  onActiveLocaleChange: (locale: string) => void
  onCopyPacksChange: (next: NonNullable<WebsiteEmbedCopyPacks>) => void
}

/** Visitor-facing phrases around the conversation, plus their per-locale overrides. */
export function ChatWordingCard({
  copyPacks,
  activeLocale,
  onActiveLocaleChange,
  onCopyPacksChange,
}: ChatWordingCardProps) {
  const [isAddingLocale, setIsAddingLocale] = useState(false)
  const [newLocaleDraft, setNewLocaleDraft] = useState('')
  const [isWordingOpen, setIsWordingOpen] = useState(false)

  const translationLocales = useMemo(
    () => Object.keys(copyPacks).filter((locale) => locale !== BASE_COPY_LOCALE).sort(),
    [copyPacks],
  )
  const activeCopyPack = copyPacks[activeLocale] ?? {}
  const basePack = copyPacks[BASE_COPY_LOCALE] ?? {}
  const customizedCopyCount = COPY_FIELDS.filter(
    ([key]) => (basePack[key] ?? '').trim().length > 0,
  ).length
  const isEditingTranslation = activeLocale !== BASE_COPY_LOCALE

  const handleCopyFieldChange = (key: string, value: string) => {
    const locale = activeLocale.trim() || BASE_COPY_LOCALE
    const nextCopy = { ...copyPacks }
    const nextPack = { ...(nextCopy[locale] ?? {}) }
    if (value.trim()) {
      nextPack[key] = value
    } else {
      delete nextPack[key]
    }
    if (Object.keys(nextPack).length > 0) {
      nextCopy[locale] = nextPack
    } else {
      delete nextCopy[locale]
    }
    onCopyPacksChange(nextCopy)
  }

  return (
    <SettingsCard
      id="chat-wording"
      icon={<Pencil className="h-5 w-5 text-primary" />}
      title="Wording"
      description="What visitors read around the conversation — buttons, placeholders, and the disclaimer."
    >
      <Collapsible
        open={isWordingOpen || isEditingTranslation}
        onOpenChange={setIsWordingOpen}
        className="space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {customizedCopyCount === 0
              ? 'Using the built-in wording.'
              : `${customizedCopyCount} of ${COPY_FIELDS.length} phrases customized.`}
            {translationLocales.length > 0
              ? ` ${translationLocales.length} added ${translationLocales.length === 1 ? 'translation' : 'translations'}.`
              : ''}
          </p>
          <CollapsibleTrigger className="group inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
            <ChevronDown className="h-3 w-3 transition-transform group-data-[state=open]:rotate-180" />
            Edit wording
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="space-y-4">
        {isEditingTranslation ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
            <span className="text-xs text-muted-foreground">
              Editing the <code>{activeLocale}</code> translation.
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7"
              onClick={() => onActiveLocaleChange(BASE_COPY_LOCALE)}
            >
              Back to default wording
            </Button>
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          {COPY_FIELDS.map(([key, label, placeholder]) => (
            <div key={key} className="space-y-2">
              <Label htmlFor={`websiteEmbedCopy-${key}`} className="text-foreground">{label}</Label>
              <Input
                id={`websiteEmbedCopy-${key}`}
                value={activeCopyPack[key] ?? ''}
                onChange={(event) => handleCopyFieldChange(key, event.target.value)}
                placeholder={placeholder}
              />
            </div>
          ))}
        </div>

        <p className="text-xs text-muted-foreground">
          Leave a field blank to use the built-in wording.
        </p>

        <div className="space-y-3 rounded-xl border border-border bg-background/60 p-4">
          <BlockHeading
            title="Translations"
            description="Spanish, French, German, Italian, Portuguese, Dutch, Polish, Chinese, Japanese, and Russian are built in. Add a language here only to override its wording."
          />
          <div className="flex flex-wrap items-center gap-2">
            {translationLocales.map((locale) => (
              <Button
                key={locale}
                type="button"
                variant={activeLocale === locale ? 'default' : 'outline'}
                size="sm"
                className="h-7"
                onClick={() => onActiveLocaleChange(locale)}
              >
                {locale}
              </Button>
            ))}
            {isAddingLocale ? (
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  const next = newLocaleDraft.trim()
                  if (!next || next === BASE_COPY_LOCALE) {
                    setIsAddingLocale(false)
                    setNewLocaleDraft('')
                    return
                  }
                  onActiveLocaleChange(next)
                  setIsAddingLocale(false)
                  setNewLocaleDraft('')
                }}
              >
                <Input
                  id="websiteEmbedCopyLocale"
                  aria-label="Language code"
                  value={newLocaleDraft}
                  onChange={(event) => setNewLocaleDraft(event.target.value)}
                  placeholder="it, fr-CA"
                  className="h-7 w-28"
                  autoFocus
                />
                <Button type="submit" size="sm" className="h-7">Add</Button>
              </form>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7"
                onClick={() => setIsAddingLocale(true)}
              >
                <Plus className="mr-1 h-3 w-3" />
                Add a translation
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Use the short language code (e.g. <code>it</code> for Italian, <code>fr-CA</code> for Canadian French).
          </p>
        </div>
        </CollapsibleContent>
      </Collapsible>
    </SettingsCard>
  )
}
