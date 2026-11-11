'use client'

import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

/**
 * Lets visitors attach photos to a message. The agent's chat model reads each photo, so the
 * setting says when that model cannot, and does not look as if it works while it cannot.
 * `chatModelReadsImages` is the server's answer for the model the agent's turns resolve.
 */
export function VisitorImagesSetting({
  enabled,
  onChange,
  chatModelReadsImages,
}: {
  enabled: boolean
  onChange: (enabled: boolean) => void
  chatModelReadsImages: boolean | undefined
}) {
  const cannotRead = chatModelReadsImages === false

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
