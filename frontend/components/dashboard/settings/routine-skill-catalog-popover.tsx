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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { routineSkillCatalogApi, type SkillAuthoringDescriptor, type SkillAuthoringInput } from '@/lib/api-routine-skill-catalog'
import type { RoutineInputBinding, RoutineSkillBindingState, RoutineStepMode } from '@/lib/routine-prose'

type RoutineSkillCatalogState = {
  agentId: string
  skills: SkillAuthoringDescriptor[]
  isLoading: boolean
  error: string | null
}

export const RoutineSkillCatalogContext = createContext<RoutineSkillCatalogState>({
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

  // Memoize so the context value keeps a stable identity across renders. Skill
  // chips now consume this context for found/unknown resolution; an unstable
  // value object re-renders every chip on every render (Playwright saw elements
  // "not stable"), so the identity must only change when the state does.
  const value = useMemo(
    () => (state.agentId === agentId ? state : { agentId, skills: [], isLoading: true, error: null }),
    [state, agentId],
  )

  return (
    <RoutineSkillCatalogContext.Provider value={value}>
      {children}
    </RoutineSkillCatalogContext.Provider>
  )
}

export const normalizeSkillName = (value: string) => value.trim().toLowerCase()

export function findRoutineSkillDescriptor(skills: SkillAuthoringDescriptor[], skillName: string, fallbackLabel = '') {
  const normalizedName = normalizeSkillName(skillName)
  const normalizedLabel = normalizeSkillName(fallbackLabel)
  return skills.find((skill) => {
    const catalogName = normalizeSkillName(skill.skillName)
    const displayName = normalizeSkillName(skill.displayName)
    return catalogName === normalizedName || catalogName === normalizedLabel || displayName === normalizedName || displayName === normalizedLabel
  })
}

export function useSkillDescriptor(skillName: string, fallbackLabel: string) {
  const catalog = useContext(RoutineSkillCatalogContext)
  const descriptor = useMemo(
    () => findRoutineSkillDescriptor(catalog.skills, skillName, fallbackLabel),
    [catalog.skills, fallbackLabel, skillName],
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

type BindingMode = 'unset' | 'literal' | 'variable' | 'context'

const modeForBinding = (binding: RoutineInputBinding | undefined): BindingMode => {
  if (!binding) return 'unset'
  if (binding.kind === 'literal') return 'literal'
  return binding.kind === 'contextVariableRef' ? 'context' : 'variable'
}

const defaultLiteralValue = (input: SkillAuthoringInput): string | number | boolean => {
  if (input.type === 'number') return 0
  if (input.type === 'boolean') return false
  if (input.type === 'enum') return input.enumValues?.[0] ?? ''
  return ''
}

const literalTextValue = (value: string | number | boolean | undefined): string => {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  return value ?? ''
}

const coerceLiteralValue = (input: SkillAuthoringInput, raw: string): string | number | boolean => {
  if (input.type === 'number') return raw === '' ? 0 : Number(raw)
  return raw
}

const cleanRecord = <T,>(record: Record<string, T>): Record<string, T> | undefined =>
  Object.keys(record).length > 0 ? record : undefined

// Who the skill is: the identity every surface shows, with or without step wiring.
function SkillCatalogIdentity({ descriptor }: { descriptor: SkillAuthoringDescriptor }) {
  return (
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
  )
}

function SkillCatalogDetails({
  descriptor,
  bindingState,
  availableVariables,
  onBindingStateChange,
}: {
  descriptor: SkillAuthoringDescriptor
  bindingState: RoutineSkillBindingState
  availableVariables: string[]
  onBindingStateChange?: (state: RoutineSkillBindingState) => void
}) {
  const inputBindings = bindingState.inputBindings ?? {}
  const outputAssignments = bindingState.outputAssignments ?? {}
  const mode = bindingState.mode ?? 'typed'

  const updateState = (next: RoutineSkillBindingState) => {
    onBindingStateChange?.({
      inputBindings: cleanRecord(next.inputBindings ?? {}),
      outputAssignments: cleanRecord(next.outputAssignments ?? {}),
      mode: next.mode ?? 'typed',
    })
  }

  const setMode = (nextMode: RoutineStepMode) => {
    updateState({ inputBindings, outputAssignments, mode: nextMode })
  }

  const setInputBinding = (input: SkillAuthoringInput, binding: RoutineInputBinding | undefined) => {
    const nextBindings = { ...inputBindings }
    if (binding) nextBindings[input.key] = binding
    else delete nextBindings[input.key]
    updateState({ inputBindings: nextBindings, outputAssignments, mode: 'typed' })
  }

  return (
    <div className="space-y-4">
      <SkillCatalogIdentity descriptor={descriptor} />

      <Tabs value={mode === 'untyped' ? 'agent-decides' : 'typed'} onValueChange={(value) => setMode(value === 'agent-decides' ? 'untyped' : 'typed')}>
        <TabsList aria-label="Skill input mode" className="h-8">
          <TabsTrigger value="typed" className="text-xs">Typed</TabsTrigger>
          <TabsTrigger value="agent-decides" disabled className="text-xs">Agent decides</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="space-y-2">
        <p className="text-xs font-medium uppercase text-muted-foreground">Inputs</p>
        {descriptor.inputs.length > 0 ? (
          <div className="space-y-2">
            {descriptor.inputs.map((input) => {
              const binding = inputBindings[input.key]
              return (
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
                  <div className="mt-2 grid gap-2">
                    <div className="space-y-1">
                      <Label htmlFor={`binding-mode-${input.key}`} className="text-xs">Binding</Label>
                      <Select
                        value={modeForBinding(binding)}
                        onValueChange={(value) => {
                          if (value === 'unset') {
                            setInputBinding(input, undefined)
                          } else if (value === 'literal') {
                            setInputBinding(input, { kind: 'literal', value: defaultLiteralValue(input) })
                          } else if (value === 'context') {
                            return
                          } else {
                            setInputBinding(input, { kind: 'variableRef', ref: availableVariables[0] ?? '' })
                          }
                        }}
                      >
                        <SelectTrigger id={`binding-mode-${input.key}`} aria-label={`Binding mode for ${input.key}`} className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="unset">Unset</SelectItem>
                          <SelectItem value="literal">Literal</SelectItem>
                          <SelectItem value="variable">Variable</SelectItem>
                          {binding?.kind === 'contextVariableRef' ? (
                            <SelectItem value="context">Context variable</SelectItem>
                          ) : null}
                        </SelectContent>
                      </Select>
                    </div>
                    {binding?.kind === 'literal' ? (
                      input.type === 'boolean' ? (
                        <div className="flex items-center gap-2">
                          <Switch
                            id={`literal-${input.key}`}
                            checked={binding.value === true}
                            onCheckedChange={(checked) => setInputBinding(input, { kind: 'literal', value: checked })}
                          />
                          <Label htmlFor={`literal-${input.key}`} className="text-xs">Literal value for {input.key}</Label>
                        </div>
                      ) : input.type === 'enum' ? (
                        <Select
                          value={literalTextValue(binding.value)}
                          onValueChange={(value) => setInputBinding(input, { kind: 'literal', value })}
                        >
                          <SelectTrigger aria-label={`Literal value for ${input.key}`} className="h-8">
                            <SelectValue placeholder="Choose value" />
                          </SelectTrigger>
                          <SelectContent>
                            {(input.enumValues ?? []).map((value) => (
                              <SelectItem key={value} value={value}>{value}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          aria-label={`Literal value for ${input.key}`}
                          type={input.type === 'number' ? 'number' : input.type === 'date' ? 'date' : input.type === 'email' ? 'email' : input.type === 'phone' ? 'tel' : 'text'}
                          value={literalTextValue(binding.value)}
                          onChange={(event) => setInputBinding(input, { kind: 'literal', value: coerceLiteralValue(input, event.target.value) })}
                        />
                      )
                    ) : null}
                    {binding?.kind === 'variableRef' ? (
                      <Select
                        value={binding.ref || '__none'}
                        onValueChange={(value) => setInputBinding(input, { kind: 'variableRef', ref: value === '__none' ? '' : value })}
                      >
                        <SelectTrigger aria-label={`Variable for ${input.key}`} className="h-8">
                          <SelectValue placeholder="Choose variable" />
                        </SelectTrigger>
                        <SelectContent>
                          {availableVariables.length === 0 ? <SelectItem value="__none">No variables available</SelectItem> : null}
                          {availableVariables.map((variable) => (
                            <SelectItem key={variable} value={variable}>{variable}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : null}
                    {binding?.kind === 'contextVariableRef' ? (
                      <div className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-muted-foreground">
                        ctx.{binding.contextVariable}
                      </div>
                    ) : null}
                  </div>
                </div>
              )
            })}
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
  bindingState = {},
  availableVariables = [],
  showStepBindings = true,
  open,
  onOpenChange,
  onBindingStateChange,
  onRemove,
}: {
  skillName: string
  label: string
  children: ReactNode
  bindingState?: RoutineSkillBindingState
  availableVariables?: string[]
  // A routine step wires the skill's inputs and outputs; a bare mention only names it.
  showStepBindings?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onBindingStateChange?: (state: RoutineSkillBindingState) => void
  onRemove?: () => void
}) {
  const { descriptor, isLoading, error } = useSkillDescriptor(skillName, label)

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
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
            showStepBindings ? (
              <SkillCatalogDetails
                descriptor={descriptor}
                bindingState={bindingState}
                availableVariables={availableVariables}
                onBindingStateChange={onBindingStateChange}
              />
            ) : (
              <SkillCatalogIdentity descriptor={descriptor} />
            )
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
