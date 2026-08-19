'use client'

import { ExternalLink } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type { AgentBrandingSettings } from '@/lib/api'
import { editionController } from '@/lib/edition-controller'

const DEFAULT_BRANDING_SETTINGS: AgentBrandingSettings = {
  hidePoweredBy: false,
  privacyPolicyUrl: null,
}

export interface ChatFooterCardProps {
  branding: AgentBrandingSettings | null
  onBrandingChange: (next: AgentBrandingSettings) => void
}

/** Everything rendered below the chat composer: the privacy link and attribution. */
export function ChatFooterCard({ branding, onBrandingChange }: ChatFooterCardProps) {
  const effectiveBranding = branding ?? DEFAULT_BRANDING_SETTINGS
  const canHideBranding = editionController.canHideAssistantBranding()

  return (
    <SettingsCard
      id="chat-footer"
      icon={<ExternalLink className="h-5 w-5 text-primary" />}
      title="Footer"
      description="What appears below the chat composer."
    >
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
            value={effectiveBranding.privacyPolicyUrl ?? ''}
            maxLength={2048}
            onChange={(event) => {
              const trimmed = event.target.value.trim()
              onBrandingChange({
                ...effectiveBranding,
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
              checked={effectiveBranding.hidePoweredBy}
              onCheckedChange={(checked) =>
                onBrandingChange({ ...effectiveBranding, hidePoweredBy: checked })
              }
            />
          </div>
        ) : null}
      </div>
    </SettingsCard>
  )
}
