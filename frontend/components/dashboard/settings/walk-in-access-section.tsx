'use client'

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { getApiErrorMessage } from '@/lib/api-error'
import { agentsApi, type AgentSettings, type AgentSettingsUpdate } from '@/lib/api'

interface PublicAccessToggles {
  agentCardEnabled: boolean
  publicAgentAccessEnabled: boolean
}

/**
 * The backend refuses walk-in access without a published card, because the card is what tells a
 * caller how to connect. Rather than surface that as a validation error, the two toggles move
 * together: opening the door publishes the card, and taking the card down closes the door.
 */
export const resolvePublicAccessToggles = (
  current: PublicAccessToggles,
  change: Partial<PublicAccessToggles>,
): PublicAccessToggles => {
  const next = { ...current, ...change }
  if (change.publicAgentAccessEnabled === true) return { agentCardEnabled: true, publicAgentAccessEnabled: true }
  if (change.agentCardEnabled === false) return { agentCardEnabled: false, publicAgentAccessEnabled: false }
  return next
}

/** An empty field means "no override"; the deployment default takes over. */
export const parseWalkInBudget = (raw: string): number | null | undefined => {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (!/^\d+$/.test(trimmed)) return undefined
  const parsed = Number(trimmed)
  return parsed >= 1 && parsed <= 100_000 ? parsed : undefined
}

export function WalkInAccessSection({ agentId }: { agentId: string }) {
  const [agent, setAgent] = useState<AgentSettings | null>(null)
  const [description, setDescription] = useState('')
  const [budget, setBudget] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [isRotateOpen, setIsRotateOpen] = useState(false)

  const budgetText = (value: number | null) => value === null ? '' : String(value)

  /** Only on load and after a failure: a save must not overwrite a field the operator is editing. */
  const adoptAll = useCallback((next: AgentSettings) => {
    setAgent(next)
    setDescription(next.publicDescription)
    setBudget(budgetText(next.walkInConversationsPerHour))
  }, [])

  useEffect(() => {
    let active = true
    agentsApi
      .getAgent(agentId)
      .then((loaded) => { if (active) adoptAll(loaded) })
      .catch((cause: unknown) => { if (active) setError(getApiErrorMessage(cause, 'Could not load open access settings.')) })
    return () => { active = false }
  }, [adoptAll, agentId])

  const save = async (update: AgentSettingsUpdate) => {
    setIsBusy(true)
    setError(null)
    try {
      const next = await agentsApi.updateAgent(agentId, update)
      setAgent(next)
      if (update.publicDescription !== undefined) setDescription(next.publicDescription)
      if (update.walkInConversationsPerHour !== undefined) setBudget(budgetText(next.walkInConversationsPerHour))
    } catch (cause: unknown) {
      setError(getApiErrorMessage(cause, 'Could not save open access settings.'))
      const reloaded = await agentsApi.getAgent(agentId).catch(() => null)
      if (reloaded) adoptAll(reloaded)
    } finally {
      setIsBusy(false)
    }
  }

  const rotate = async () => {
    setIsBusy(true)
    setError(null)
    try {
      setAgent(await agentsApi.rotateAgentPublicId(agentId))
    } catch (cause: unknown) {
      setError(getApiErrorMessage(cause, 'Could not rotate the public id.'))
    } finally {
      setIsBusy(false)
    }
  }

  if (!agent) {
    return error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null
  }

  const toggles: PublicAccessToggles = {
    agentCardEnabled: agent.agentCardEnabled,
    publicAgentAccessEnabled: agent.publicAgentAccessEnabled,
  }

  const applyToggles = (change: Partial<PublicAccessToggles>) =>
    void save(resolvePublicAccessToggles(toggles, change))

  return (
    <div className="space-y-5 border-t border-border pt-5">
      <div>
        <Label className="text-foreground">Open access</Label>
        <p className="text-xs text-muted-foreground">How another AI agent finds this one and whether it needs a credential.</p>
      </div>

      <div className="flex items-start gap-3">
        <Switch
          checked={agent.agentCardEnabled}
          onCheckedChange={(checked) => applyToggles({ agentCardEnabled: checked })}
          disabled={isBusy}
          aria-label="Publish the agent card"
        />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Publish the agent card</p>
          <p className="text-xs text-muted-foreground">Says what this agent does, what it can run, and how to connect.</p>
        </div>
      </div>

      <div className="flex items-start gap-3">
        <Switch
          checked={agent.publicAgentAccessEnabled}
          onCheckedChange={(checked) => applyToggles({ publicAgentAccessEnabled: checked })}
          disabled={isBusy}
          aria-label="Allow connecting without a credential"
        />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Allow connecting without a credential</p>
          <p className="text-xs text-muted-foreground">Any AI agent that has the public id can start a conversation. Publishes the card too.</p>
        </div>
      </div>

      {agent.publicId ? (
        <div className="space-y-2">
          <Label className="text-foreground">Public id</Label>
          <div className="flex items-center gap-2">
            <CopyValueField value={agent.publicId} ariaLabel="Copy agent public id" className="min-w-0 flex-1" />
            <Button type="button" variant="outline" size="sm" disabled={isBusy} onClick={() => setIsRotateOpen(true)}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Rotate
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Safe to publish. It is an address, not a secret.</p>
        </div>
      ) : null}

      <div className="space-y-2">
        <Label className="text-foreground" htmlFor="agent-public-description">Description</Label>
        <Textarea
          id="agent-public-description"
          value={description}
          maxLength={500}
          rows={2}
          placeholder="Answers questions about orders, returns, and delivery."
          onChange={(event) => setDescription(event.target.value)}
          onBlur={() => {
            if (description !== agent.publicDescription) void save({ publicDescription: description })
          }}
        />
        <p className="text-xs text-muted-foreground">The one line a calling agent reads before deciding to ask.</p>
      </div>

      {agent.publicAgentAccessEnabled ? (
        <div className="space-y-2">
          <Label className="text-foreground" htmlFor="agent-walk-in-budget">New conversations per hour</Label>
          <Input
            id="agent-walk-in-budget"
            inputMode="numeric"
            value={budget}
            className="max-w-40"
            placeholder="Deployment default"
            onChange={(event) => setBudget(event.target.value)}
            onBlur={() => {
              const parsed = parseWalkInBudget(budget)
              if (parsed === undefined) {
                setError('Enter a whole number of conversations between 1 and 100000, or leave it empty.')
                return
              }
              if (parsed !== agent.walkInConversationsPerHour) void save({ walkInConversationsPerHour: parsed })
            }}
          />
          <p className="text-xs text-muted-foreground">Caps what one looping caller can spend from the workspace&rsquo;s conversation allowance.</p>
        </div>
      ) : null}

      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

      <AlertDialog open={isRotateOpen} onOpenChange={setIsRotateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate the public id?</AlertDialogTitle>
            <AlertDialogDescription>
              Every agent connected without a credential is disconnected on its next request, and any card or link
              carrying the current id stops resolving. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setIsRotateOpen(false); void rotate() }} disabled={isBusy}>
              Rotate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
