'use client'

import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, PlugZap, RefreshCw, Trash2, Wrench } from 'lucide-react'

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

const modeLabel: Record<ParamMode, string> = {
  expose: 'Expose',
  bind: 'Bind',
  ignore: 'Ignore',
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

  return (
    <SettingsCard
      id="external-skills"
      icon={<PlugZap className="h-5 w-5 text-primary" />}
      title="External MCP skills"
      description="Connect outbound MCP servers and expose selected tools as named routine skills."
      headerEnd={(
        <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={isLoading}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      )}
    >
      <div className="space-y-6">
        {error ? <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Loading external skills...
          </div>
        ) : (
          <>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,0.9fr)]">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h4 className="text-sm font-medium text-foreground">MCP connections</h4>
                  <Badge variant="secondary">{connections.length}</Badge>
                </div>
                {connections.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                    No outbound MCP connections are configured for this agent.
                  </p>
                ) : (
                  <div className="divide-y divide-border rounded-md border border-border">
                    {connections.map((connection) => (
                      <div key={connection.id} className="flex items-start justify-between gap-3 p-3">
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left"
                          onClick={() => setSelectedConnectionId(connection.id)}
                        >
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-foreground">{connection.displayName}</span>
                            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusTone(connection.status)}`}>
                              {connection.status}
                            </span>
                          </div>
                          <p className="truncate text-xs text-muted-foreground">{connection.serverUrl}</p>
                          {selectedConnectionId === connection.id ? (
                            <p className="mt-1 text-xs text-primary">Selected</p>
                          ) : null}
                        </button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${connection.displayName}`}
                          onClick={() => void deleteConnection(connection.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-3 rounded-md border border-border p-3">
                <h4 className="text-sm font-medium text-foreground">New connection</h4>
                <div className="space-y-2">
                  <Label htmlFor="externalSkillConnectionName">Display name</Label>
                  <Input id="externalSkillConnectionName" value={connectionName} onChange={(event) => setConnectionName(event.target.value)} placeholder="Support MCP" />
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
                  disabled={isSavingConnection || !connectionName.trim() || !serverUrl.trim() || !accessToken.trim()}
                >
                  {isSavingConnection ? <Spinner className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                  Save connection
                </Button>
              </div>
            </div>

            <div className="space-y-4 rounded-md border border-border p-3">
              <div className="flex flex-col gap-3 md:flex-row md:items-end">
                <div className="min-w-0 flex-1 space-y-2">
                  <Label>Connection</Label>
                  <Select value={selectedConnectionId} onValueChange={setSelectedConnectionId}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select a connection" />
                    </SelectTrigger>
                    <SelectContent>
                      {connections.map((connection) => (
                        <SelectItem key={connection.id} value={connection.id}>{connection.displayName}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button type="button" variant="outline" onClick={() => void discoverTools()} disabled={!selectedConnectionId || isDiscovering}>
                  {isDiscovering ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
                  Discover tools
                </Button>
              </div>

              {selectedConnection ? (
                <p className="text-xs text-muted-foreground">
                  Discovery calls {selectedConnection.displayName} live and uses the stored credential.
                </p>
              ) : null}

              {tools.length > 0 ? (
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
                        <Label htmlFor="externalSkillName">Routine skill name</Label>
                        <Input id="externalSkillName" value={skillName} onChange={(event) => setSkillName(event.target.value)} placeholder="handoff_slack" />
                      </div>

                      <div className="space-y-2">
                        <h4 className="text-sm font-medium text-foreground">Tool inputs</h4>
                        {fields.length === 0 ? (
                          <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                            This tool did not publish a JSON-schema input list. Save it with no bound or exposed inputs.
                          </p>
                        ) : (
                          <div className="divide-y divide-border rounded-md border border-border">
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
              ) : null}
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-sm font-medium text-foreground">Defined skills</h4>
                <Badge variant="secondary">{skills.length}</Badge>
              </div>
              {skills.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                  No external skills yet. Define one, then reference it in a routine tool step by name.
                </p>
              ) : (
                <div className="divide-y divide-border rounded-md border border-border">
                  {skills.map((skill) => (
                    <div key={skill.id} className="flex flex-col gap-3 p-3 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm font-medium text-foreground">{skill.skillName}</span>
                          <Badge variant="secondary">{skill.toolName}</Badge>
                          {!skill.enabled ? <Badge variant="outline">disabled</Badge> : null}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Bound: {summarizeParams(skill.boundParams)} · Exposed: {summarizeParams(skill.exposedParams)}
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
      {mode === 'bind' ? (
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor={`bound-${field.name}`}>Bound value</Label>
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
            <Label htmlFor={`slot-${field.name}`}>Slot binding</Label>
            <Input
              id={`slot-${field.name}`}
              value={exposedParam.slotBinding}
              onChange={(event) => onExposedParamChange({ ...exposedParam, slotBinding: event.target.value })}
              placeholder={field.name}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`description-${field.name}`}>Description</Label>
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
