'use client'

import { ChevronDown, FileUp, Globe, Pencil, Plug, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { KnowledgeAddAction } from '@/lib/dashboard-routes'

export type AddDocumentAction = KnowledgeAddAction

interface AddDocumentMenuProps {
  // Website crawling is gated per workspace; when disabled, the "Crawl website"
  // entry is hidden while the other add flows stay available.
  websiteCrawlerEnabled: boolean
  onSelect: (action: AddDocumentAction) => void
  compact?: boolean
}

// Shared "Add" affordance used by both the Documents tab header and the Sources
// tab header so the two surfaces present an identical dropdown of add flows.
export function AddDocumentMenu({
  websiteCrawlerEnabled,
  onSelect,
  compact = false,
}: AddDocumentMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant={compact ? 'outline' : 'default'}
          className={compact ? undefined : 'h-10 px-3.5'}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add
          <ChevronDown className="ml-1.5 h-3.5 w-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {websiteCrawlerEnabled ? (
          <DropdownMenuItem onClick={() => onSelect('crawl')}>
            <Globe className="mr-2 h-4 w-4" />
            Crawl website
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onClick={() => onSelect('import')}>
          <FileUp className="mr-2 h-4 w-4" />
          Import file
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onSelect('create')}>
          <Pencil className="mr-2 h-4 w-4" />
          Write document
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onSelect('wordpress')}>
          <Plug className="mr-2 h-4 w-4" />
          Connect WordPress
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
