'use client'

import { useState } from 'react'
import { ChevronRight } from 'lucide-react'

import { attributeHelp, surfacingLabels, type SurfacingOption } from '@/components/dashboard/settings/attribute-copy'
import { SettingFieldHeader } from '@/components/dashboard/settings/settings-flow'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { ContextVariableCreateRequest } from '@/lib/api'

type AdvancedAttributeSettings = Pick<
  ContextVariableCreateRequest,
  'trustTier' | 'sensitivity' | 'defaultSurfacing'
>

const defaultAdvancedSettings: AdvancedAttributeSettings = {
  trustTier: 'unverified',
  sensitivity: 'normal',
  defaultSurfacing: 'on_reference',
}

const hasNonDefaultAdvancedSettings = (settings: AdvancedAttributeSettings): boolean =>
  settings.trustTier !== defaultAdvancedSettings.trustTier ||
  settings.sensitivity !== defaultAdvancedSettings.sensitivity ||
  settings.defaultSurfacing !== defaultAdvancedSettings.defaultSurfacing

function CheckboxField({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string
  label: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 h-4 w-4 shrink-0 accent-primary"
      />
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-foreground">{label}</Label>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

/** Collapsed unless the attribute already carries a non-default setting, so nothing set stays hidden. */
export function AttributeAdvancedFields({
  settings,
  onChange,
}: {
  settings: AdvancedAttributeSettings
  onChange: (patch: Partial<AdvancedAttributeSettings>) => void
}) {
  const [open, setOpen] = useState(() => hasNonDefaultAdvancedSettings(settings))
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-border">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-foreground">
        <ChevronRight className={`h-4 w-4 transition-transform ${open ? 'rotate-90' : ''}`} />
        Advanced
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 border-t border-border p-3">
        <CheckboxField
          id="contextVariableSigned"
          label="Signed by your server"
          description={attributeHelp.signed.description}
          checked={settings.trustTier === 'signed'}
          onChange={(checked) => onChange({ trustTier: checked ? 'signed' : 'unverified' })}
        />
        <CheckboxField
          id="contextVariablePrivate"
          label="Private data"
          description={attributeHelp.private.description}
          checked={settings.sensitivity === 'sensitive'}
          onChange={(checked) => onChange({ sensitivity: checked ? 'sensitive' : 'normal' })}
        />
        <div className="space-y-2">
          <SettingFieldHeader
            htmlFor="contextVariableDefaultSurfacing"
            label="Used by"
            description={attributeHelp.usedBy.description}
            tooltip={attributeHelp.usedBy.tooltip}
          />
          <Select
            value={settings.defaultSurfacing}
            onValueChange={(value) => onChange({ defaultSurfacing: value as SurfacingOption })}
          >
            <SelectTrigger id="contextVariableDefaultSurfacing">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(surfacingLabels) as SurfacingOption[]).map((surfacing) => (
                <SelectItem key={surfacing} value={surfacing}>{surfacingLabels[surfacing]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
