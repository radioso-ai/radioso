'use client'

import {
  BellRing,
  Cable,
  DatabaseZap,
  Mail,
  MessageSquareText,
  Webhook,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { AgentSkillCapabilityId, SkillCapabilityDescriptor } from '@/lib/api-skills'
import { cn } from '@/lib/utils'
import { formatCapabilityLabel } from './skill-form-model'

const capabilityIcons: Record<AgentSkillCapabilityId, { icon: LucideIcon; tone: string }> = {
  retrieve: {
    icon: DatabaseZap,
    tone: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/50 dark:text-emerald-300',
  },
  mcp_tool: {
    icon: Cable,
    tone: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/70 dark:bg-blue-950/50 dark:text-blue-300',
  },
  email: {
    icon: Mail,
    tone: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/50 dark:text-rose-300',
  },
  slack_post: {
    icon: MessageSquareText,
    tone: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/70 dark:bg-violet-950/50 dark:text-violet-300',
  },
  webhook_call: {
    icon: Webhook,
    tone: 'border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-900/70 dark:bg-cyan-950/50 dark:text-cyan-300',
  },
  notify: {
    icon: BellRing,
    tone: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/50 dark:text-amber-300',
  },
}

const defaultCapabilityIcon = {
  icon: Wrench,
  tone: 'border-border bg-background text-muted-foreground',
}

const unavailableReasonLabel = (capability: SkillCapabilityDescriptor) => {
  if (capability.unavailableReason === 'no_connection') {
    return 'Needs connection'
  }
  return capability.unavailableReason ?? 'Unavailable'
}

const capabilityDescription = (capability: SkillCapabilityDescriptor) => {
  const inputCount = capability.inputSchema.source === 'static' && Array.isArray(capability.inputSchema.schema.fields)
    ? capability.inputSchema.schema.fields.length
    : null
  const targetSummary = (capability.requiresTarget ?? true)
    ? `${capability.targets.length} ${capability.targets.length === 1 ? 'target' : 'targets'}`
    : 'Config-only'
  const inputSummary = inputCount === null
    ? 'Discovered inputs'
    : `${inputCount} ${inputCount === 1 ? 'input' : 'inputs'}`
  return `${targetSummary} · ${inputSummary}`
}

const DEFAULT_DESCRIPTION =
  'Choose the capability type to configure. Connection-backed capabilities unlock when their setup exists.'

// The first step of authoring a skill: which capability it instantiates. Surfaces that can only
// accept some capabilities pass a narrowed list and say why in `description`.
export function CapabilityPicker({
  open,
  capabilities,
  description = DEFAULT_DESCRIPTION,
  onOpenChange,
  onSelect,
}: {
  open: boolean
  capabilities: SkillCapabilityDescriptor[]
  description?: string
  onOpenChange: (open: boolean) => void
  onSelect: (capabilityId: AgentSkillCapabilityId) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add new skill</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {capabilities.map((capability) => {
            const enabled = capability.available
            const icon = capabilityIcons[capability.id] ?? defaultCapabilityIcon
            const CapabilityIcon = icon.icon
            return (
              <button
                key={capability.id}
                type="button"
                disabled={!enabled}
                onClick={() => onSelect(capability.id)}
                className={cn(
                  'flex aspect-square min-h-36 flex-col justify-between rounded-md border p-4 text-left transition-colors',
                  enabled
                    ? 'border-border bg-background hover:border-primary/60 hover:bg-muted/30'
                    : 'cursor-not-allowed border-border/70 bg-muted/20 text-muted-foreground opacity-70',
                )}
              >
                <span className="space-y-3">
                  <span className={cn(
                    'inline-flex h-9 w-9 items-center justify-center rounded-md border',
                    enabled ? icon.tone : 'border-border bg-background text-muted-foreground',
                  )}>
                    <CapabilityIcon className="h-4 w-4" />
                  </span>
                  <span className="block">
                    <span className="block text-sm font-medium text-foreground">{formatCapabilityLabel(capability.id)}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">{capabilityDescription(capability)}</span>
                  </span>
                </span>
                <span className="mt-3 flex items-center justify-between gap-2 text-xs">
                  {enabled ? (
                    <Badge variant="secondary">Ready</Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">{unavailableReasonLabel(capability)}</Badge>
                  )}
                  {!enabled && (capability.requiresTarget ?? true) ? (
                    <span className="text-muted-foreground">Connections</span>
                  ) : null}
                </span>
              </button>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
