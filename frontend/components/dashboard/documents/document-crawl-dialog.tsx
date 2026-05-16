'use client'

import { useState, type FormEvent } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

export function DocumentCrawlDialog({
  open,
  url,
  crawlError,
  isCrawling,
  maxLimit,
  limit,
  includeUrlPatterns,
  excludeUrlPatterns,
  preserveContentLinks,
  onOpenChange,
  onSubmit,
  onUrlChange,
  onLimitChange,
  onIncludeUrlPatternsChange,
  onExcludeUrlPatternsChange,
  onPreserveContentLinksChange,
}: {
  open: boolean
  url: string
  crawlError: string | null
  isCrawling: boolean
  maxLimit: number
  limit: string
  includeUrlPatterns: string
  excludeUrlPatterns: string
  preserveContentLinks: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (event: FormEvent) => void
  onUrlChange: (value: string) => void
  onLimitChange: (value: string) => void
  onIncludeUrlPatternsChange: (value: string) => void
  onExcludeUrlPatternsChange: (value: string) => void
  onPreserveContentLinksChange: (value: boolean) => void
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const trimmedUrl = url.trim()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Crawl Website</DialogTitle>
          <DialogDescription>
            Fetch pages from a public website and add them to your knowledge base.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="mt-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="crawlUrl">Website URL</Label>
            <Input
              id="crawlUrl"
              type="url"
              inputMode="url"
              autoComplete="url"
              placeholder="https://example.com"
              value={url}
              onChange={(event) => onUrlChange(event.target.value)}
              disabled={isCrawling}
              required
            />
            <p className="text-xs text-muted-foreground">
              Up to {maxLimit.toLocaleString()} pages will be crawled.
            </p>
          </div>
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" className="h-8 px-0 text-xs text-muted-foreground" disabled={isCrawling}>
                {advancedOpen ? <ChevronDown className="mr-1 h-3.5 w-3.5" /> : <ChevronRight className="mr-1 h-3.5 w-3.5" />}
                Advanced
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label htmlFor="crawlLimit">Page limit</Label>
                <Input
                  id="crawlLimit"
                  type="number"
                  min={1}
                  max={maxLimit}
                  inputMode="numeric"
                  placeholder={String(maxLimit)}
                  value={limit}
                  onChange={(event) => onLimitChange(event.target.value)}
                  disabled={isCrawling}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="crawlIncludePatterns">URL allow list</Label>
                <Textarea
                  id="crawlIncludePatterns"
                  rows={3}
                  placeholder={'/blog/\n/docs/'}
                  value={includeUrlPatterns}
                  onChange={(event) => onIncludeUrlPatternsChange(event.target.value)}
                  disabled={isCrawling}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="crawlExcludePatterns">URL deny list</Label>
                <Textarea
                  id="crawlExcludePatterns"
                  rows={3}
                  placeholder={'/tag/\n/search'}
                  value={excludeUrlPatterns}
                  onChange={(event) => onExcludeUrlPatternsChange(event.target.value)}
                  disabled={isCrawling}
                />
              </div>
              <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                <Label htmlFor="crawlPreserveLinks" className="text-sm">Preserve source links</Label>
                <Switch
                  id="crawlPreserveLinks"
                  checked={preserveContentLinks}
                  onCheckedChange={onPreserveContentLinksChange}
                  disabled={isCrawling}
                />
              </div>
            </CollapsibleContent>
          </Collapsible>
          {crawlError ? (
            <p className="text-sm text-destructive" role="alert">
              {crawlError}
            </p>
          ) : null}
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isCrawling}>
              Cancel
            </Button>
            <Button type="submit" disabled={isCrawling || trimmedUrl.length === 0}>
              {isCrawling ? <Spinner className="mr-2" /> : null}
              Start Crawl
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
