'use client'

import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'

import { AddLanguageField, LanguageGroup, LineWarning } from '@/components/dashboard/settings/locale-lines-editor'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { AgentBrandingSettings } from '@/lib/api'
import {
  isCompletePrivacyNoticeRow,
  privacyNoticeRowsOf,
  privacyNoticesOf,
  samePrivacyNotices,
  type PrivacyNoticeFormRow,
} from '@/lib/privacy-notice'

const MAX_LANGUAGES = 10
const MAX_LINE_LENGTH = 200
const MAX_LINK_LENGTH = 500

const DEFAULT_BRANDING: AgentBrandingSettings = { hidePoweredBy: false, privacyPolicyUrl: null }

interface PrivacyNoticeCardProps {
  branding: AgentBrandingSettings | null
  onBrandingChange: (next: AgentBrandingSettings) => void
}

/**
 * The agent's privacy notice: one line and a policy link per language. A row saves once it has
 * both; until then it stays in the form, so a half-typed link never fails the live save.
 */
export function PrivacyNoticeCard({ branding, onBrandingChange }: PrivacyNoticeCardProps) {
  const current = branding ?? DEFAULT_BRANDING
  const [rows, setRows] = useState<PrivacyNoticeFormRow[]>(() => privacyNoticeRowsOf(current.privacyNotice))

  const update = (next: PrivacyNoticeFormRow[]) => {
    setRows(next)
    const notices = privacyNoticesOf(next, current.privacyNotice)
    if (!samePrivacyNotices(notices, current.privacyNotice)) {
      onBrandingChange({ ...current, privacyNotice: notices })
    }
  }
  const replace = (locale: string, patch: Partial<PrivacyNoticeFormRow>) =>
    update(rows.map((row) => (row.locale === locale ? { ...row, ...patch } : row)))

  return (
    <SettingsCard
      id="privacy-notice"
      icon={<ShieldCheck className="h-5 w-5 text-primary" />}
      title="Privacy notice"
      description="One line and a link to your policy, shown before a visitor's first message and sent with an email's first reply."
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>Shown as you write it. Off until you add a language.</span>
        <Badge variant="outline">Applies live now</Badge>
      </div>
      <div className="space-y-3">
        {rows.map((row) => {
          const saved = current.privacyNotice?.[row.locale]
          const complete = isCompletePrivacyNoticeRow(row)
          return (
            <LanguageGroup
              key={row.locale}
              locale={row.locale}
              label="Privacy notice"
              onRemove={() => update(rows.filter((candidate) => candidate.locale !== row.locale))}
            >
              <div className="space-y-1">
                <Label htmlFor={`privacyNoticeText-${row.locale}`} className="text-foreground">Line</Label>
                <Input
                  id={`privacyNoticeText-${row.locale}`}
                  value={row.text}
                  maxLength={MAX_LINE_LENGTH}
                  placeholder="We use your messages to answer you."
                  onChange={(event) => replace(row.locale, { text: event.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`privacyNoticeUrl-${row.locale}`} className="text-foreground">Policy link</Label>
                <Input
                  id={`privacyNoticeUrl-${row.locale}`}
                  type="url"
                  inputMode="url"
                  value={row.url}
                  maxLength={MAX_LINK_LENGTH}
                  placeholder="https://example.com/privacy"
                  onChange={(event) => replace(row.locale, { url: event.target.value })}
                />
              </div>
              {complete ? (
                saved?.version ? <p className="text-xs text-muted-foreground">Version {saved.version}</p> : null
              ) : (
                <LineWarning text="Add a line and an http or https link to show this notice." />
              )}
            </LanguageGroup>
          )
        })}
        <AddLanguageField
          id="privacyNoticeLanguage"
          existingLocales={rows.map((row) => row.locale)}
          maxLanguages={MAX_LANGUAGES}
          onAdd={(locale) => setRows([...rows, { locale, text: '', url: current.privacyPolicyUrl ?? '' }])}
        />
      </div>
    </SettingsCard>
  )
}
