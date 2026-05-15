'use client'

import type { FormEvent } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'

export function DocumentCrawlDialog({
  open,
  url,
  crawlError,
  isCrawling,
  maxLimit,
  onOpenChange,
  onSubmit,
  onUrlChange,
}: {
  open: boolean
  url: string
  crawlError: string | null
  isCrawling: boolean
  maxLimit: number
  onOpenChange: (open: boolean) => void
  onSubmit: (event: FormEvent) => void
  onUrlChange: (value: string) => void
}) {
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
