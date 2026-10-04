'use client'

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { McpConnectionsSection } from './McpConnectionsSection'

export function McpServersPanel({ agentId, open, onOpenChange }: {
  agentId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-xl">
        <SheetHeader className="border-b border-border px-6 py-5 pr-12">
          <SheetTitle>MCP connections</SheetTitle>
          <SheetDescription>Connect servers that provide tools for this agent’s skills.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <McpConnectionsSection key={agentId} agentId={agentId} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
