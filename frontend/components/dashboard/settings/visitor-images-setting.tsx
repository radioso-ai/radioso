'use client'

import { useEffect, useState } from 'react'

import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { llmProvidersApi, type LlmCapabilityPreference, type WorkspaceLlmModels } from '@/lib/api-llm-providers'
import { agentImageReading } from '@/lib/visitor-image-model'

/**
 * Lets visitors attach photos to a message. The agent's chat model reads each photo, so the
 * setting says when that model cannot, and does not look as if it works while it cannot.
 */
export function VisitorImagesSetting({
  enabled,
  onChange,
  chatModelOverride,
}: {
  enabled: boolean
  onChange: (enabled: boolean) => void
  chatModelOverride: LlmCapabilityPreference | null | undefined
}) {
  const [models, setModels] = useState<WorkspaceLlmModels | null>(null)
  useEffect(() => {
    let active = true
    llmProvidersApi
      .getModels()
      .then((response) => {
        if (active) setModels(response)
      })
      .catch(() => {
        // Without the model catalog the setting cannot say which models read images, so it stays quiet.
      })
    return () => {
      active = false
    }
  }, [])
  const cannotRead = agentImageReading({ override: chatModelOverride, models }) === 'cannot_read'

  return (
    <div className="flex items-start justify-between gap-4 p-3">
      <div className="min-w-0">
        <Label htmlFor="visitorImagesEnabled" className="text-foreground">
          Let visitors send photos
        </Label>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Visitors attach up to three photos to a message in the web chat and on your site. The agent reads each one
          and answers from what it sees.
        </p>
        {cannotRead ? (
          <p className="mt-1 text-sm text-amber-700 dark:text-amber-400" role="note">
            {enabled
              ? 'Not working: this agent’s chat model can’t read photos, so visitors see no attach button.'
              : 'This agent’s chat model can’t read photos. Pick another model to turn this on.'}
          </p>
        ) : null}
      </div>
      <Switch
        id="visitorImagesEnabled"
        checked={enabled}
        onCheckedChange={onChange}
        // A model that cannot read photos cannot be given a setting that does nothing; one already on can still be turned off.
        disabled={cannotRead && !enabled}
      />
    </div>
  )
}
