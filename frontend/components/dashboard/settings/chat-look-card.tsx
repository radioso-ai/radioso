'use client'

import { useState } from 'react'
import { ChevronDown, Pencil, Sparkles, Trash2, Upload } from 'lucide-react'

import {
  ADVANCED_THEME_FIELDS,
  applyBrand,
  applySurface,
  applySurfaceMode,
  getSurfaceMode,
  type SurfaceMode,
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
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { Spinner } from '@/components/ui/spinner'
import type { WebsiteEmbedThemeSettings } from '@/lib/api'

const SURFACE_MODE_OPTIONS: readonly SegmentedControlOption<SurfaceMode>[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'custom', label: 'Custom' },
]

export interface ChatLookCardProps {
  theme: WebsiteEmbedThemeSettings
  logoUrl: string | null
  /** True while any settings save is in flight, which locks the logo controls. */
  isLogoBusy: boolean
  isLogoSaving: boolean
  onThemeChange: (updater: (current: WebsiteEmbedThemeSettings) => WebsiteEmbedThemeSettings) => void
  onLogoUpload: (file: File | null) => void
  onLogoDelete: () => void
}

/** Logo and colors, shared by every placement of the chat surface. */
export function ChatLookCard({
  theme,
  logoUrl,
  isLogoBusy,
  isLogoSaving,
  onThemeChange,
  onLogoUpload,
  onLogoDelete,
}: ChatLookCardProps) {
  const surfaceMode = getSurfaceMode(theme)

  return (
    <SettingsCard
      id="chat-look"
      icon={<Sparkles className="h-5 w-5 text-primary" />}
      title="Look"
      description="Logo and colors, used everywhere this chat appears."
    >
      <div className="space-y-6">
        <LogoField
          logoUrl={logoUrl}
          busy={isLogoBusy}
          isSaving={isLogoSaving}
          onUpload={onLogoUpload}
          onDelete={onLogoDelete}
        />

        <div className="space-y-1">
          <Label htmlFor="assistantTheme-brand" className="text-foreground">Brand color</Label>
          <div className="flex items-center gap-2">
            <Input
              id="assistantTheme-brand"
              type="color"
              value={theme.brand}
              onChange={(event) => {
                const next = event.target.value
                onThemeChange((current) => applyBrand(current, next))
              }}
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
          <SegmentedControl
            value={surfaceMode}
            onValueChange={(surfaceOption) => {
              if (surfaceOption === 'custom') {
                if (surfaceMode !== 'custom') {
                  onThemeChange((current) => applySurface(current, '#f6f7f9'))
                }
                return
              }
              onThemeChange((current) => applySurfaceMode(current, surfaceOption))
            }}
            options={SURFACE_MODE_OPTIONS}
          />
          <p className="text-xs text-muted-foreground">
            Background of the message area. Pick Light or Dark for a sensible neutral, or Custom to choose any color.
          </p>
          {surfaceMode === 'custom' ? (
            <div className="flex items-center gap-2 pt-1">
              <Input
                id="assistantTheme-surface"
                type="color"
                value={theme.surface}
                onChange={(event) => {
                  const next = event.target.value
                  onThemeChange((current) => applySurface(current, next))
                }}
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
                      onChange={(event) => {
                        const next = event.target.value
                        onThemeChange((current) => ({ ...current, [key]: next }))
                      }}
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
    </SettingsCard>
  )
}

export function LogoField({
  logoUrl,
  busy,
  isSaving,
  onUpload,
  onDelete,
}: {
  logoUrl: string | null
  busy: boolean
  isSaving: boolean
  onUpload: (file: File | null) => void
  onDelete: () => void
}) {
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null)
  const [fileInput, setFileInput] = useState<HTMLInputElement | null>(null)
  const hasLogo = Boolean(logoUrl)
  const showLogo = Boolean(logoUrl && failedLogoUrl !== logoUrl)

  return (
    <div className="space-y-2">
      <Label className="text-foreground">Logo</Label>
      <div className="flex items-center gap-3">
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
                disabled={busy}
                className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSaving ? <Spinner className="h-3 w-3" /> : <Pencil className="h-3 w-3" />}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault()
                  fileInput?.click()
                }}
              >
                <Upload className="mr-2 h-4 w-4" />
                {hasLogo ? 'Replace' : 'Upload'}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onDelete()} disabled={!hasLogo}>
                <Trash2 className="mr-2 h-4 w-4" />
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input
            ref={setFileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="sr-only"
            onChange={(event) => {
              onUpload(event.target.files?.[0] ?? null)
              event.currentTarget.value = ''
            }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Shown in the chat header and beside each answer.
        </p>
      </div>
    </div>
  )
}
