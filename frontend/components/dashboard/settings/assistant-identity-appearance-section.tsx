'use client'

import { useRef, useState } from 'react'
import { ChevronDown, Pencil, Sparkles, Trash2, Upload } from 'lucide-react'

import {
  ADVANCED_THEME_FIELDS,
  applyBrand,
  applySurface,
  applySurfaceMode,
  DEFAULT_ASSISTANT_THEME,
  getSurfaceMode,
} from '@/components/dashboard/settings/assistant-theme-form-helpers'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import type { AgentBrandingSettings, AssistantBehaviorSettings, GeneralSettings } from '@/lib/api'
import { editionController } from '@/lib/edition-controller'

const DEFAULT_BRANDING_SETTINGS: AgentBrandingSettings = {
  hidePoweredBy: false,
  privacyPolicyUrl: null,
}

function SubsectionHeading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="space-y-0.5">
      <h4 className="text-sm font-semibold text-foreground">{title}</h4>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
    </div>
  )
}

export interface AssistantIdentityAppearanceSectionProps {
  anonSettings: GeneralSettings
  assistantBehaviorSettings: AssistantBehaviorSettings
  onAssistantSettingChange: <K extends keyof GeneralSettings>(key: K, value: GeneralSettings[K]) => void
  onAssistantBehaviorDraft: (updater: (current: AssistantBehaviorSettings) => AssistantBehaviorSettings) => void
  onAssistantLogoUpload: (file: File | null) => void
  onAssistantLogoDelete: () => void
  isAnonSaving: boolean
  isAssistantLogoSaving: boolean
}

export function AssistantIdentityAppearanceSection({
  anonSettings,
  assistantBehaviorSettings,
  onAssistantSettingChange,
  onAssistantBehaviorDraft,
  onAssistantLogoUpload,
  onAssistantLogoDelete,
  isAnonSaving,
  isAssistantLogoSaving,
}: AssistantIdentityAppearanceSectionProps) {
  const theme = assistantBehaviorSettings.theme ?? DEFAULT_ASSISTANT_THEME
  const surfaceMode = getSurfaceMode(theme)
  const branding = assistantBehaviorSettings.branding ?? DEFAULT_BRANDING_SETTINGS
  const canHideBranding = editionController.canHideAssistantBranding()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const logoUrl = anonSettings.assistantLogoUrl
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null)
  const hasLogo = Boolean(logoUrl)
  const showLogo = Boolean(logoUrl && failedLogoUrl !== logoUrl)
  const logoBusy = isAnonSaving || isAssistantLogoSaving

  const updateBranding = (next: AgentBrandingSettings) => {
    onAssistantBehaviorDraft((current) => ({
      ...current,
      branding: next,
    }))
  }

  const logoBadge = (
    <div className="relative h-11 w-11">
      <div className="flex h-full w-full items-center justify-center overflow-hidden rounded-2xl border border-border bg-background">
        {showLogo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoUrl ?? ''}
            alt=""
            className="h-full w-full object-contain"
            onError={() => setFailedLogoUrl(logoUrl)}
          />
        ) : (
          <Sparkles className="h-5 w-5 text-primary" />
        )}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Edit assistant logo"
            disabled={logoBusy}
            className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isAssistantLogoSaving ? <Spinner className="h-3 w-3" /> : <Pencil className="h-3 w-3" />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault()
              fileInputRef.current?.click()
            }}
          >
            <Upload className="mr-2 h-4 w-4" />
            {hasLogo ? 'Replace' : 'Upload'}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => onAssistantLogoDelete()}
            disabled={!hasLogo}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="sr-only"
        onChange={(event) => {
          onAssistantLogoUpload(event.target.files?.[0] ?? null)
          event.currentTarget.value = ''
        }}
      />
    </div>
  )

  return (
    <SettingsCard
      id="assistant-identity"
      icon={logoBadge}
      iconClassName="border-0 bg-transparent p-0 overflow-visible"
      title="Identity & appearance"
      description="Name, logo, and the look of the chat."
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="assistantName" className="text-foreground">Assistant name</Label>
          <Input
            id="assistantName"
            value={anonSettings.assistantName}
            maxLength={200}
            onChange={(event) => onAssistantSettingChange('assistantName', event.target.value)}
            placeholder="e.g. Marta"
          />
          <p className="text-xs text-muted-foreground">
            Shown as the chat title. Falls back to the workspace name when left blank.
          </p>
        </div>

        <div className="h-px bg-border" />

        <div className="space-y-4">
          <SubsectionHeading
            title="Appearance"
            description="Colors used by the public chat and the hosted website widget."
          />

          <div className="space-y-1">
            <Label htmlFor="assistantTheme-brand" className="text-foreground">Brand color</Label>
            <div className="flex items-center gap-2">
              <Input
                id="assistantTheme-brand"
                type="color"
                value={theme.brand}
                onChange={(event) =>
                  onAssistantBehaviorDraft((current) => ({
                    ...current,
                    theme: applyBrand(current.theme ?? DEFAULT_ASSISTANT_THEME, event.target.value),
                  }))
                }
                className="h-9 w-14 cursor-pointer p-1"
              />
              <span className="text-xs font-mono text-muted-foreground">{theme.brand}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Drives the chat header, user message bubbles, and the send button.
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-foreground">Surface style</Label>
            <div className="inline-flex rounded-md border border-border bg-muted/40 p-0.5" role="group">
              {(['light', 'dark', 'custom'] as const).map((mode) => {
                const isActive = surfaceMode === mode
                return (
                  <button
                    key={mode}
                    type="button"
                    className={`rounded-sm px-3 py-1 text-xs font-medium capitalize transition-colors ${
                      isActive ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                    }`}
                    onClick={() => {
                      if (mode === 'custom') {
                        if (surfaceMode !== 'custom') {
                          onAssistantBehaviorDraft((current) => ({
                            ...current,
                            theme: applySurface(current.theme ?? DEFAULT_ASSISTANT_THEME, '#f6f7f9'),
                          }))
                        }
                        return
                      }
                      onAssistantBehaviorDraft((current) => ({
                        ...current,
                        theme: applySurfaceMode(current.theme ?? DEFAULT_ASSISTANT_THEME, mode),
                      }))
                    }}
                  >
                    {mode}
                  </button>
                )
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Background of the message area. Pick Light or Dark for a sensible neutral, or Custom to choose any color.
            </p>
            {surfaceMode === 'custom' ? (
              <div className="flex items-center gap-2 pt-1">
                <Input
                  id="assistantTheme-surface"
                  type="color"
                  value={theme.surface}
                  onChange={(event) =>
                    onAssistantBehaviorDraft((current) => ({
                      ...current,
                      theme: applySurface(current.theme ?? DEFAULT_ASSISTANT_THEME, event.target.value),
                    }))
                  }
                  className="h-9 w-14 cursor-pointer p-1"
                />
                <span className="text-xs font-mono text-muted-foreground">{theme.surface}</span>
              </div>
            ) : null}
          </div>

          <Collapsible className="space-y-3">
            <CollapsibleTrigger className="group inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
              <ChevronDown className="h-3 w-3 transition-transform group-data-[state=open]:rotate-180" />
              Advanced colors
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="grid gap-3 sm:grid-cols-2">
                {ADVANCED_THEME_FIELDS.map(({ key, label, hint }) => (
                  <div key={key} className="space-y-1">
                    <Label htmlFor={`assistantTheme-${key}`} className="text-foreground">{label}</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        id={`assistantTheme-${key}`}
                        type="color"
                        value={theme[key]}
                        onChange={(event) =>
                          onAssistantBehaviorDraft((current) => ({
                            ...current,
                            theme: {
                              ...(current.theme ?? DEFAULT_ASSISTANT_THEME),
                              [key]: event.target.value,
                            },
                          }))
                        }
                        className="h-9 w-14 cursor-pointer p-1"
                      />
                      <span className="text-xs font-mono text-muted-foreground">{theme[key]}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">{hint}</p>
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>

        <div className="h-px bg-border" />

        <div className="space-y-4">
          <SubsectionHeading
            title="Branding & disclaimers"
            description="What appears below the chat composer."
          />
          <div className="divide-y divide-border rounded-lg border border-border">
            <div className="space-y-2 p-3">
              <Label htmlFor="brandingPrivacyPolicyUrl" className="text-foreground">
                Privacy policy URL
              </Label>
              <Input
                id="brandingPrivacyPolicyUrl"
                type="url"
                inputMode="url"
                placeholder="https://example.com/privacy"
                value={branding.privacyPolicyUrl ?? ''}
                maxLength={2048}
                onChange={(event) => {
                  const trimmed = event.target.value.trim()
                  updateBranding({
                    ...branding,
                    privacyPolicyUrl: trimmed.length > 0 ? event.target.value : null,
                  })
                }}
              />
              <p className="text-xs text-muted-foreground">
                When set, a &ldquo;Privacy&rdquo; link is shown in the chat footer.
              </p>
            </div>
            {canHideBranding ? (
              <div className="flex items-start justify-between gap-4 p-3">
                <div className="min-w-0">
                  <Label htmlFor="brandingHidePoweredBy" className="text-foreground">
                    Hide &ldquo;Answers by Radioso&rdquo;
                  </Label>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Removes Radioso attribution from the chat footer.
                  </p>
                </div>
                <Switch
                  id="brandingHidePoweredBy"
                  checked={branding.hidePoweredBy}
                  onCheckedChange={(checked) => updateBranding({ ...branding, hidePoweredBy: checked })}
                />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </SettingsCard>
  )
}
