'use client'

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AlertCircle, Database, ListChecks, Loader2, Trash2 } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { routineSkillCatalogApi, type SkillAuthoringDescriptor } from '@/lib/api-routine-skill-catalog'

type RoutineSkillCatalogState = {
  agentId: string
  skills: SkillAuthoringDescriptor[]
  isLoading: boolean
  error: string | null
}

const RoutineSkillCatalogContext = createContext<RoutineSkillCatalogState>({
  agentId: '',
  skills: [],
  isLoading: false,
  error: null,
})

export function RoutineSkillCatalogProvider({ agentId, children }: { agentId: string; children: ReactNode }) {
  const [state, setState] = useState<RoutineSkillCatalogState>({ agentId: '', skills: [], isLoading: true, error: null })

  useEffect(() => {
    let cancelled = false
    routineSkillCatalogApi.listRoutineSkillCatalog(agentId)
      .then((skills) => {
        if (!cancelled) setState({ agentId, skills, isLoading: false, error: null })
      })
      .catch(() => {
        if (!cancelled) setState({ agentId, skills: [], isLoading: false, error: 'Could not load the skill catalog.' })
      })
    return () => {
      cancelled = true
    }
  }, [agentId])

  const value = state.agentId === agentId
    ? state
    : { agentId, skills: [], isLoading: true, error: null }

  return (
    <RoutineSkillCatalogContext.Provider value={value}>
      {children}
    </RoutineSkillCatalogContext.Provider>
  )
}

const normalizeSkillName = (value: string) => value.trim().toLowerCase()

function useSkillDescriptor(skillName: string, fallbackLabel: string) {
  const catalog = useContext(RoutineSkillCatalogContext)
  const normalizedName = normalizeSkillName(skillName)
  const normalizedLabel = normalizeSkillName(fallbackLabel)
  const descriptor = useMemo(
    () => catalog.skills.find((skill) => {
      const catalogName = normalizeSkillName(skill.skillName)
      const displayName = normalizeSkillName(skill.displayName)
      return catalogName === normalizedName || catalogName === normalizedLabel || displayName === normalizedName || displayName === normalizedLabel
    }),
    [catalog.skills, normalizedLabel, normalizedName],
  )
  return { ...catalog, descriptor }
}

function RequiredMarker({ required }: { required: boolean }) {
  return (
    <span className={required ? 'text-amber-600 dark:text-amber-300' : 'text-muted-foreground'}>
      {required ? 'required' : 'optional'}
    </span>
  )
}

function SkillCatalogDetails({ descriptor }: { descriptor: SkillAuthoringDescriptor }) {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="flex items-start gap-2">
          <Database className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">{descriptor.displayName}</p>
            <p className="text-xs text-muted-foreground">{descriptor.skillName}</p>
          </div>
        </div>
        {descriptor.description ? <p className="text-xs leading-5 text-muted-foreground">{descriptor.description}</p> : null}
      </div>

      <Tabs value="typed">
        <TabsList aria-label="Skill input mode" className="h-8">
          <TabsTrigger value="typed" className="text-xs">Typed</TabsTrigger>
          <TabsTrigger value="agent-decides" disabled className="text-xs">Agent decides</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="space-y-2">
        <p className="text-xs font-medium uppercase text-muted-foreground">Inputs</p>
        {descriptor.inputs.length > 0 ? (
          <div className="space-y-2">
            {descriptor.inputs.map((input) => (
              <div key={input.key} className="rounded-md border border-border bg-muted/30 p-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium text-foreground">{input.key}</span>
                  <span className="rounded border border-border px-1.5 py-0.5 text-muted-foreground">{input.type}</span>
                  <RequiredMarker required={input.required} />
                </div>
                {input.description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{input.description}</p> : null}
                {input.type === 'enum' && input.enumValues?.length ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {input.enumValues.map((value) => (
                      <span key={value} className="rounded bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">{value}</span>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="rounded-md border border-dashed border-border p-2 text-xs text-muted-foreground">
            No typed input ports.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium uppercase text-muted-foreground">Outcomes</p>
        {descriptor.outcomes.length > 0 ? (
          <div className="space-y-2">
            {descriptor.outcomes.map((outcome) => (
              <div key={`${outcome.name}:${outcome.status}`} className="rounded-md border border-border bg-muted/30 p-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <ListChecks className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-medium text-foreground">{outcome.displayName}</span>
                  <span className="rounded border border-border px-1.5 py-0.5 text-muted-foreground">{outcome.status}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{outcome.name}</p>
                {outcome.description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{outcome.description}</p> : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="rounded-md border border-dashed border-border p-2 text-xs text-muted-foreground">
            No declared outcomes.
          </p>
        )}
        {!descriptor.hasDataOutputs ? (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-200">
            This skill has no data outputs; only outcome-based routing is available.
          </p>
        ) : null}
      </div>
    </div>
  )
}

export function RoutineSkillCatalogPopover({
  skillName,
  label,
  children,
  onRemove,
}: {
  skillName: string
  label: string
  children: ReactNode
  onRemove?: () => void
}) {
  const { descriptor, isLoading, error } = useSkillDescriptor(skillName, label)

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-96 max-w-[calc(100vw-2rem)] p-4" onCloseAutoFocus={(event) => event.preventDefault()}>
        <div role="dialog" aria-label={`Skill catalog for ${label}`}>
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading skill catalog...
            </div>
          ) : error ? (
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          ) : descriptor ? (
            <SkillCatalogDetails descriptor={descriptor} />
          ) : (
            <div className="space-y-1">
              <p className="text-sm font-semibold text-foreground">{label}</p>
              <p className="text-xs text-muted-foreground">This skill is not in the authoring catalog yet.</p>
            </div>
          )}
        </div>
        {onRemove ? (
          <>
            <div className="my-3 h-px bg-border" />
            <DropdownMenuItem onClick={onRemove} className="text-destructive focus:text-destructive">
              <Trash2 className="h-4 w-4" />
              Remove
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
