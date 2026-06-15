'use client'

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { CheckCircle2, PlugZap, Plus, RefreshCw, Trash2, Wrench, X } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { getApiErrorMessage } from '@/lib/api-error'
import { externalSkillsApi, type ExternalSkillDefinition, type McpConnection } from '@/lib/api'
import {
  buildExternalSkillDraft,
  defaultParamModes,
  defaultSkillName,
  getToolInputFields,
  type BoundValueMap,
  type DiscoveredMcpTool,
  type ExposedParamDraftMap,
  type ParamMode,
  type ParamModeMap,
  type ToolInputField,
} from '@/lib/external-skills'

const statusTone = (status: string) => {
  if (status === 'authorized') return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  if (status === 'needs_reauth' || status === 'error') return 'bg-destructive/10 text-destructive'
  return 'bg-muted text-muted-foreground'
}

const statusLabel = (status: string) => {
  if (status === 'authorized') return 'Connected'
  if (status === 'needs_reauth') return 'Needs re-auth'
  if (status === 'error') return 'Error'
  if (status === 'unconfigured') return 'Not verified'
  return status
}

const modeLabel: Record<ParamMode, string> = {
  expose: 'Ask in chat',
  bind: 'Fixed value',
  ignore: 'Skip',
}

const modeHelp: Record<ParamMode, string> = {
  expose: 'The conversation collects this value before the tool runs.',
  bind: 'Always send the same preset value.',
  ignore: 'Leave this input out of the call.',
}

const summarizeParams = (params: Record<string, unknown>) => Object.keys(params).join(', ') || 'none'

function initialExposedParams(fields: readonly ToolInputField[]): ExposedParamDraftMap {
  return Object.fromEntries(fields.map((field) => [
    field.name,
    { description: field.description ?? '', slotBinding: field.name },
  ]))
}

function initialBoundValues(fields: readonly ToolInputField[]): BoundValueMap {
  return Object.fromEntries(fields.map((field) => [
    field.name,
    field.type === 'boolean' ? 'false' : field.type === 'number' ? '0' : '',
  ]))
}

export function AssistantExternalSkillsSection({ agentId }: { agentId: string }) {
  const [connections, setConnections] = useState<McpConnection[]>([])
  const [skills, setSkills] = useState<ExternalSkillDefinition[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSavingConnection, setIsSavingConnection] = useState(false)
  const [isDiscovering, setIsDiscovering] = useState(false)
  const [isSavingSkill, setIsSavingSkill] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [isAddingConnection, setIsAddingConnection] = useState(false)
  const [connectionName, setConnectionName] = useState('')
  const [serverUrl, setServerUrl] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [selectedConnectionId, setSelectedConnectionId] = useState('')
  const [tools, setTools] = useState<DiscoveredMcpTool[]>([])
  const [selectedToolName, setSelectedToolName] = useState('')
  const [skillName, setSkillName] = useState('')
  const [paramModes, setParamModes] = useState<ParamModeMap>({})
  const [boundValues, setBoundValues] = useState<BoundValueMap>({})
  const [exposedParams, setExposedParams] = useState<ExposedParamDraftMap>({})

  const selectedConnection = connections.find((connection) => connection.id === selectedConnectionId) ?? null
  const selectedTool = tools.find((tool) => tool.name === selectedToolName) ?? null
  const fields = useMemo(() => getToolInputFields(selectedTool?.inputSchema), [selectedTool])

  const load = async () => {
    setIsLoading(true)
    setError(null)
    try {
      const [connectionResponse, skillResponse] = await Promise.all([
        externalSkillsApi.listConnections(agentId),
        externalSkillsApi.listSkills(agentId),
      ])
      setConnections(connectionResponse.connections)
      setSkills(skillResponse.skills)
      setSelectedConnectionId((current) => current || connectionResponse.connections[0]?.id || '')
    } catch (loadError) {
      setError(getApiErrorMessage(loadError, 'Failed to load external skills.'))
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    queueMicrotask(() => {
      void load()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Reload when the owning agent changes.
  }, [agentId])

  useEffect(() => {
    queueMicrotask(() => {
      setSelectedToolName('')
      setTools([])
    })
  }, [selectedConnectionId])

  useEffect(() => {
    queueMicrotask(() => {
      if (!selectedTool) {
        setSkillName('')
        setParamModes({})
        setBoundValues({})
        setExposedParams({})
        return
      }
      const nextFields = getToolInputFields(selectedTool.inputSchema)
      setSkillName(defaultSkillName(selectedTool.name))
      setParamModes(defaultParamModes(nextFields))
      setBoundValues(initialBoundValues(nextFields))
      setExposedParams(initialExposedParams(nextFields))
    })
  }, [selectedTool])

  const createConnection = async () => {
    setIsSavingConnection(true)
    setError(null)
    try {
      const connection = await externalSkillsApi.createConnection(agentId, {
        displayName: connectionName,
        serverUrl,
        authMethod: 'access_token',
        accessToken,
      })
      setConnections((current) => [connection, ...current])
      setSelectedConnectionId(connection.id)
      setConnectionName('')
      setServerUrl('')
      setAccessToken('')
      setIsAddingConnection(false)
    } catch (saveError) {
      setError(getApiErrorMessage(saveError, 'Failed to create MCP connection.'))
    } finally {
      setIsSavingConnection(false)
    }
  }

  const deleteConnection = async (connectionId: string) => {
    setError(null)
    try {
      await externalSkillsApi.deleteConnection(agentId, connectionId)
      setConnections((current) => current.filter((connection) => connection.id !== connectionId))
      setSelectedConnectionId((current) => current === connectionId ? '' : current)
      setSkills((current) => current.filter((skill) => skill.connectionId !== connectionId))
    } catch (deleteError) {
      setError(getApiErrorMessage(deleteError, 'Failed to delete MCP connection.'))
    }
  }

  const discoverTools = async () => {
    if (!selectedConnectionId) return
    setIsDiscovering(true)
    setError(null)
    try {
      const response = await externalSkillsApi.discoverTools(agentId, selectedConnectionId)
      setTools(response.tools)
      setSelectedToolName(response.tools[0]?.name ?? '')
    } catch (discoverError) {
      setError(getApiErrorMessage(discoverError, 'Failed to discover MCP tools.'))
    } finally {
      setIsDiscovering(false)
    }
  }

  const createSkill = async () => {
    if (!selectedTool || !selectedConnectionId) return
    setIsSavingSkill(true)
    setError(null)
    try {
      const payload = buildExternalSkillDraft({
        skillName,
        connectionId: selectedConnectionId,
        tool: selectedTool,
        paramModes,
        boundValues,
        exposedParams,
      })
      const skill = await externalSkillsApi.createSkill(agentId, payload)
      setSkills((current) => [skill, ...current])
    } catch (saveError) {
      setError(getApiErrorMessage(saveError, 'Failed to create external skill.'))
    } finally {
      setIsSavingSkill(false)
    }
  }

  const toggleSkill = async (skill: ExternalSkillDefinition, enabled: boolean) => {
    setError(null)
    try {
      const updated = await externalSkillsApi.updateSkill(agentId, skill.id, { enabled })
      setSkills((current) => current.map((entry) => entry.id === updated.id ? updated : entry))
    } catch (updateError) {
      setError(getApiErrorMessage(updateError, 'Failed to update external skill.'))
    }
  }

  const deleteSkill = async (skillId: string) => {
    setError(null)
    try {
      await externalSkillsApi.deleteSkill(agentId, skillId)
      setSkills((current) => current.filter((skill) => skill.id !== skillId))
    } catch (deleteError) {
      setError(getApiErrorMessage(deleteError, 'Failed to delete external skill.'))
    }
  }

  const showConnectionForm = isAddingConnection || connections.length === 0
  const canSaveConnection = Boolean(connectionName.trim() && serverUrl.trim() && accessToken.trim())

  return (
    <SettingsCard
      id="external-skills"
      icon={<PlugZap className="h-5 w-5 text-primary" />}
      title="External MCP skills"
      description="Let this agent call tools on outside MCP servers. Connect a server, then turn one of its tools into a named skill you can use inside a routine."
      headerEnd={(
        <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={isLoading}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      )}
    >
      <div className="space-y-8">
        {error ? <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Loading external skills...
          </div>
        ) : (
          <>
            <Step
              index={1}
              title="Connect an MCP server"
              description="Add the outbound servers this agent is allowed to reach. Access tokens are encrypted by the backend."
            >
              {connections.length > 0 ? (
                <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                  {connections.map((connection) => {
                    const isSelected = selectedConnectionId === connection.id
                    return (
                      <div
                        key={connection.id}
                        className={cn('flex items-start justify-between gap-3', isSelected && 'bg-primary/5')}
                      >
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-start gap-3 p-3 text-left"
                          onClick={() => setSelectedConnectionId(connection.id)}
                          aria-pressed={isSelected}
                        >
                          <span
                            className={cn(
                              'mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                              isSelected ? 'border-primary' : 'border-muted-foreground/40',
                            )}
                          >
                            {isSelected ? <span className="h-2 w-2 rounded-full bg-primary" /> : null}
                          </span>
                          <span className="min-w-0">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-medium text-foreground">{connection.displayName}</span>
                              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusTone(connection.status)}`}>
                                {statusLabel(connection.status)}
                              </span>
                            </span>
                            <span className="mt-0.5 block truncate text-xs text-muted-foreground">{connection.serverUrl}</span>
                          </span>
                        </button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="m-1.5 shrink-0"
                          aria-label={`Delete ${connection.displayName}`}
                          onClick={() => void deleteConnection(connection.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )
                  })}
                </div>
              ) : null}

              {showConnectionForm ? (
                <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h5 className="text-sm font-medium text-foreground">New server</h5>
                    {connections.length > 0 ? (
                      <Button type="button" variant="ghost" size="icon" aria-label="Cancel" onClick={() => setIsAddingConnection(false)}>
                        <X className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="externalSkillConnectionName">Display name</Label>
                    <Input id="externalSkillConnectionName" value={connectionName} onChange={(event) => setConnectionName(event.target.value)} placeholder="Support MCP" />
                    <p className="text-xs text-muted-foreground">A label to recognize this server when you pick it in Step 2. (The name you reference from a routine is the skill name you set there, not this one.)</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="externalSkillServerUrl">Server URL</Label>
                    <Input id="externalSkillServerUrl" type="url" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="https://mcp.example.com/mcp" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="externalSkillAccessToken">Access token</Label>
                    <Input id="externalSkillAccessToken" type="password" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} placeholder="Stored encrypted by the backend" />
                  </div>
                  <Button
                    type="button"
                    onClick={() => void createConnection()}
                    disabled={isSavingConnection || !canSaveConnection}
                  >
                    {isSavingConnection ? <Spinner className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                    Save server
                  </Button>
                </div>
              ) : (
                <Button type="button" variant="outline" size="sm" onClick={() => setIsAddingConnection(true)}>
                  <Plus className="h-4 w-4" />
                  Add a server
                </Button>
              )}
            </Step>

            <Step
              index={2}
              title="Turn a tool into a skill"
              description="Discover the tools on a server, then expose one as a named skill. You reference that name from a routine tool step."
            >
              {connections.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                  Connect a server above to discover its tools.
                </p>
              ) : (
                <>
                  <div className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 text-sm">
                      {selectedConnection ? (
                        <>
                          <span className="text-muted-foreground">Selected server: </span>
                          <span className="font-medium text-foreground">{selectedConnection.displayName}</span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">Select a server above to continue.</span>
                      )}
                    </div>
                    <Button type="button" variant="outline" onClick={() => void discoverTools()} disabled={!selectedConnectionId || isDiscovering} className="shrink-0">
                      {isDiscovering ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
                      Discover tools
                    </Button>
                  </div>

                  {tools.length > 0 ? (
                    <div className="space-y-4 rounded-lg border border-border p-4">
                      <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
                        <div className="space-y-2">
                          <Label>Tool</Label>
                          <Select value={selectedToolName} onValueChange={setSelectedToolName}>
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Select a tool" />
                            </SelectTrigger>
                            <SelectContent>
                              {tools.map((tool) => (
                                <SelectItem key={tool.name} value={tool.name}>{tool.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {selectedTool?.description ? (
                            <p className="text-xs text-muted-foreground">{selectedTool.description}</p>
                          ) : null}
                        </div>

                        {selectedTool ? (
                          <div className="space-y-4">
                            <div className="space-y-2">
                              <Label htmlFor="externalSkillName">Skill name</Label>
                              <Input id="externalSkillName" value={skillName} onChange={(event) => setSkillName(event.target.value)} placeholder="handoff_slack" />
                              <p className="text-xs text-muted-foreground">This is the name a routine uses to refer to the skill — type it into a routine tool step to run it. Lowercase, no spaces.</p>
                            </div>

                            <div className="space-y-2">
                              <div>
                                <h5 className="text-sm font-medium text-foreground">Tool inputs</h5>
                                <p className="text-xs text-muted-foreground">For each input, decide whether the chat asks for it, you preset a fixed value, or it&apos;s skipped.</p>
                              </div>
                              {fields.length === 0 ? (
                                <p className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                                  This tool did not publish an input list. You can save it with no inputs.
                                </p>
                              ) : (
                                <div className="divide-y divide-border rounded-lg border border-border">
                                  {fields.map((field) => (
                                    <ParamRow
                                      key={field.name}
                                      field={field}
                                      mode={paramModes[field.name] ?? 'ignore'}
                                      boundValue={boundValues[field.name] ?? ''}
                                      exposedParam={exposedParams[field.name] ?? { description: '', slotBinding: field.name }}
                                      onModeChange={(mode) => setParamModes((current) => ({ ...current, [field.name]: mode }))}
                                      onBoundValueChange={(value) => setBoundValues((current) => ({ ...current, [field.name]: value }))}
                                      onExposedParamChange={(value) => setExposedParams((current) => ({ ...current, [field.name]: value }))}
                                    />
                                  ))}
                                </div>
                              )}
                            </div>

                            <Button
                              type="button"
                              onClick={() => void createSkill()}
                              disabled={isSavingSkill || !skillName.trim()}
                            >
                              {isSavingSkill ? <Spinner className="h-4 w-4" /> : <Wrench className="h-4 w-4" />}
                              Save skill
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </Step>

            <div className="space-y-3 border-t border-border pt-6">
              <div>
                <h4 className="text-sm font-medium text-foreground">Defined skills</h4>
                <p className="text-xs text-muted-foreground">Reference a skill by name from a routine tool step.</p>
              </div>
              {skills.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                  No skills yet. Use the steps above to create your first one.
                </p>
              ) : (
                <div className="divide-y divide-border rounded-lg border border-border">
                  {skills.map((skill) => (
                    <div key={skill.id} className="flex flex-col gap-3 p-3 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm font-medium text-foreground">{skill.skillName}</span>
                          <Badge variant="secondary">{skill.toolName}</Badge>
                          {!skill.enabled ? <Badge variant="outline">disabled</Badge> : null}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Asked in chat: {summarizeParams(skill.exposedParams)} · Fixed: {summarizeParams(skill.boundParams)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={skill.enabled}
                          onCheckedChange={(enabled) => void toggleSkill(skill, enabled)}
                          aria-label={`Enable ${skill.skillName}`}
                        />
                        <Button type="button" variant="ghost" size="icon" aria-label={`Delete ${skill.skillName}`} onClick={() => void deleteSkill(skill.id)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </SettingsCard>
  )
}

function Step({
  index,
  title,
  description,
  children,
}: {
  index: number
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 gap-y-3">
      <div className="flex h-7 w-7 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-sm font-semibold text-primary">
        {index}
      </div>
      <div className="min-w-0">
        <h4 className="text-sm font-medium text-foreground">{title}</h4>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="col-start-2 space-y-3">{children}</div>
    </div>
  )
}

function ParamRow({
  field,
  mode,
  boundValue,
  exposedParam,
  onModeChange,
  onBoundValueChange,
  onExposedParamChange,
}: {
  field: ToolInputField
  mode: ParamMode
  boundValue: string
  exposedParam: { description: string; slotBinding: string }
  onModeChange: (mode: ParamMode) => void
  onBoundValueChange: (value: string) => void
  onExposedParamChange: (value: { description: string; slotBinding: string }) => void
}) {
  return (
    <div className="grid gap-3 p-3 md:grid-cols-[minmax(0,1fr)_9rem]">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-medium text-foreground">{field.name}</span>
          <Badge variant="secondary">{field.type}</Badge>
          {field.required ? <Badge variant="outline">required</Badge> : null}
        </div>
        {field.description ? <p className="text-xs text-muted-foreground">{field.description}</p> : null}
      </div>
      <div className="space-y-1">
        <Select value={mode} onValueChange={(value) => onModeChange(value as ParamMode)}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(modeLabel).map(([value, label]) => (
              <SelectItem key={value} value={value}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{modeHelp[mode]}</p>
      </div>
      {mode === 'bind' ? (
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor={`bound-${field.name}`}>Fixed value</Label>
          <Input
            id={`bound-${field.name}`}
            value={boundValue}
            onChange={(event) => onBoundValueChange(event.target.value)}
            placeholder={field.type === 'object' || field.type === 'array' ? 'JSON value' : 'Preset value'}
          />
        </div>
      ) : null}
      {mode === 'expose' ? (
        <div className="grid gap-3 md:col-span-2 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`slot-${field.name}`}>Save answer as</Label>
            <Input
              id={`slot-${field.name}`}
              value={exposedParam.slotBinding}
              onChange={(event) => onExposedParamChange({ ...exposedParam, slotBinding: event.target.value })}
              placeholder={field.name}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`description-${field.name}`}>What to ask for</Label>
            <Textarea
              id={`description-${field.name}`}
              value={exposedParam.description}
              onChange={(event) => onExposedParamChange({ ...exposedParam, description: event.target.value })}
              className="min-h-10"
              placeholder="What the conversation should collect"
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}
