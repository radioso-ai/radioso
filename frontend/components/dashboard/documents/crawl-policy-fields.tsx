'use client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

interface CrawlPolicyFieldsProps {
  idPrefix: string
  limit: string
  maxLimit?: number
  includeUrlPatterns: string
  excludeUrlPatterns: string
  preserveContentLinks: boolean
  disabled?: boolean
  onLimitChange: (value: string) => void
  onIncludeUrlPatternsChange: (value: string) => void
  onExcludeUrlPatternsChange: (value: string) => void
  onPreserveContentLinksChange: (value: boolean) => void
}

export function CrawlPolicyFields({
  idPrefix,
  limit,
  maxLimit,
  includeUrlPatterns,
  excludeUrlPatterns,
  preserveContentLinks,
  disabled,
  onLimitChange,
  onIncludeUrlPatternsChange,
  onExcludeUrlPatternsChange,
  onPreserveContentLinksChange,
}: CrawlPolicyFieldsProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-limit`}>Page limit</Label>
        <Input
          id={`${idPrefix}-limit`}
          type="number"
          min={1}
          max={maxLimit}
          inputMode="numeric"
          placeholder={maxLimit !== undefined ? String(maxLimit) : undefined}
          value={limit}
          onChange={(event) => onLimitChange(event.target.value)}
          disabled={disabled}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-include`}>URL allow list</Label>
        <Textarea
          id={`${idPrefix}-include`}
          rows={3}
          placeholder={'/blog/\n/docs/*'}
          value={includeUrlPatterns}
          onChange={(event) => onIncludeUrlPatternsChange(event.target.value)}
          disabled={disabled}
        />
        <p className="text-xs text-muted-foreground">
          One pattern per line. Plain text matches as a substring; <code>*</code> is a wildcard for any
          sequence (e.g. <code>/blog/*/2025</code>).
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-exclude`}>URL deny list</Label>
        <Textarea
          id={`${idPrefix}-exclude`}
          rows={3}
          placeholder={'/tag/\n/search/*'}
          value={excludeUrlPatterns}
          onChange={(event) => onExcludeUrlPatternsChange(event.target.value)}
          disabled={disabled}
        />
      </div>
      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
        <Label htmlFor={`${idPrefix}-preserve`} className="text-sm">
          Preserve source links
        </Label>
        <Switch
          id={`${idPrefix}-preserve`}
          checked={preserveContentLinks}
          onCheckedChange={onPreserveContentLinksChange}
          disabled={disabled}
        />
      </div>
    </div>
  )
}
