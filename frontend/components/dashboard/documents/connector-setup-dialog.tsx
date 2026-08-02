'use client'

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Download, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LogoSpinner, Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  ConnectorConflictError,
  ConnectorValidationError,
  connectorsApi,
  type ConnectorConfigFieldDefinition,
  type ConnectorDetail,
} from '@/lib/api-connectors'
import { getApiErrorMessage } from '@/lib/api-error'

type FieldValueMap = Record<string, string>
type FieldErrorMap = Record<string, string>

const SECRET_REMEDIATION_PLACEHOLDER = '[re-enter secret]'
const WORDPRESS_PLUGIN_DOWNLOAD_PATH = '/radioso-sync.zip'

const isMaskedSecret = (value: string | undefined): boolean => {
  if (!value) return false
  if (value === SECRET_REMEDIATION_PLACEHOLDER) return true
  // Mask format is "****1234" (asterisks + last 4 chars). Treat any value that
  // starts with at least 3 asterisks as the stored mask.
  return /^\*{3,}/.test(value)
}

const initialFormValues = (detail: ConnectorDetail): FieldValueMap => {
  const result: FieldValueMap = {}
  for (const field of detail.schema) {
    if (field.type === 'secret' || field.type === 'generated_secret') {
      // Secrets are never editable through `values`: user-supplied secrets
      // use empty=keep-existing semantics, and generated secrets are read-only.
      result[field.key] = ''
      continue
    }
    const stored = detail.config?.[field.key]
    if (typeof stored === 'string' && stored.length > 0) {
      result[field.key] = stored
      continue
    }
    result[field.key] = field.defaultValue ?? ''
  }
  return result
}

const buildSubmitPayload = (
  schema: ConnectorConfigFieldDefinition[],
  values: FieldValueMap,
): FieldValueMap => {
  const payload: FieldValueMap = {}
  for (const field of schema) {
    if (field.type === 'generated_secret') {
      // Issued by Radioso. The backend keeps the stored value; never overwrite.
      continue
    }
    const value = values[field.key] ?? ''
    if (field.type === 'secret') {
      const trimmed = value.trim()
      if (trimmed.length > 0) {
        payload[field.key] = trimmed
      }
      continue
    }
    payload[field.key] = value
  }
  return payload
}

const WORDPRESS_POLLING_KEYS = new Set(['wp_username', 'wp_application_password'])
const WORDPRESS_ADVANCED_KEYS = new Set(['post_types', 'poll_interval_sec'])

const formatDateTime = (value: string | null): string => {
  if (!value) return 'Never'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Never' : date.toLocaleString()
}

const formatIngestedCount = (value: number | null): string => {
  if (value === null) return 'Unknown'
  return `${value} ${value === 1 ? 'document' : 'documents'}`
}

const formatConnectorErrorStatus = (value: string): string => {
  if (value === 'sync_failed') return 'Sync failed'
  return value
}

interface FieldGroup {
  primary: ConnectorConfigFieldDefinition[]
  polling: ConnectorConfigFieldDefinition[]
  advanced: ConnectorConfigFieldDefinition[]
}

const groupWordpressFields = (
  schema: ConnectorConfigFieldDefinition[],
): FieldGroup => {
  const groups: FieldGroup = { primary: [], polling: [], advanced: [] }
  for (const field of schema) {
    if (WORDPRESS_POLLING_KEYS.has(field.key)) {
      groups.polling.push(field)
    } else if (WORDPRESS_ADVANCED_KEYS.has(field.key)) {
      groups.advanced.push(field)
    } else {
      groups.primary.push(field)
    }
  }
  return groups
}

function WordpressSetupGuide() {
  return (
    <div className="rounded-md border border-border bg-muted/40 p-4 text-sm">
      <p className="mb-3 font-medium text-foreground">How to set this up</p>
      <ol className="list-decimal space-y-2 pl-5 text-muted-foreground">
        <li>
          <span className="text-foreground">Download the Radioso Sync plugin</span> and save the
          <span className="font-mono"> .zip</span> file to your computer.
          <div className="mt-2">
            <Button asChild variant="secondary" size="sm">
              <a href={WORDPRESS_PLUGIN_DOWNLOAD_PATH} download>
                <Download className="mr-2 h-4 w-4" />
                Download plugin
              </a>
            </Button>
          </div>
        </li>
        <li>
          In WordPress, go to <span className="text-foreground">Plugins → Add New → Upload Plugin</span>,
          choose the file, then click <span className="text-foreground">Install Now</span> and{' '}
          <span className="text-foreground">Activate</span>.
        </li>
        <li>
          Open <span className="text-foreground">Settings → Radioso Sync</span> inside WordPress and
          paste the <span className="text-foreground">webhook URL</span> and{' '}
          <span className="text-foreground">webhook shared secret</span> from below. Save.
        </li>
        <li>
          Click <span className="text-foreground">Enable</span> here. New and updated posts will
          start arriving automatically.
        </li>
      </ol>
    </div>
  )
}

function ConnectorSyncStatus({ detail }: { detail: ConnectorDetail }) {
  const state = detail.syncState
  const status = (() => {
    if (detail.errorStatus) {
      return { label: formatConnectorErrorStatus(detail.errorStatus), className: 'text-destructive' }
    }
    if (!detail.enabled) return { label: 'Disabled', className: 'text-muted-foreground' }
    if (state.syncRequestedAt) {
      return { label: 'Sync queued', className: 'text-muted-foreground' }
    }
    if (state.syncStartedAt) {
      return { label: 'Sync running', className: 'text-muted-foreground' }
    }
    if (!state.backfillCompletedAt && state.lastRunAt) {
      return { label: 'Backfill started', className: 'text-muted-foreground' }
    }
    if (!state.backfillCompletedAt) {
      return { label: 'Waiting for first backfill', className: 'text-muted-foreground' }
    }
    return { label: 'Synced', className: 'text-emerald-600 dark:text-emerald-400' }
  })()

  return (
    <div className="rounded-md border border-border bg-background/40 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-foreground">Sync status</p>
        <span className={`text-xs font-medium ${status.className}`}>{status.label}</span>
      </div>
      <dl className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <div>
          <dt className="font-medium text-foreground">Last backfill</dt>
          <dd>{formatDateTime(state.backfillCompletedAt)}</dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">Last sync attempt</dt>
          <dd>{formatDateTime(state.lastRunAt)}</dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">Latest upstream update</dt>
          <dd>{formatDateTime(state.lastModifiedAt)}</dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">Last sync ingested</dt>
          <dd>{formatIngestedCount(state.lastIngestedCount)}</dd>
        </div>
      </dl>
      {state.lastError ? (
        <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-xs font-medium text-destructive">Latest sync error</p>
          <p className="mt-1 text-xs text-destructive/90">{state.lastError}</p>
        </div>
      ) : null}
    </div>
  )
}

export function ConnectorSetupDialog({
  open,
  connectorId,
  onOpenChange,
  context,
}: {
  open: boolean
  connectorId: string
  onOpenChange: (open: boolean) => void
  context?: ReactNode
}) {
  const [detail, setDetail] = useState<ConnectorDetail | null>(null)
  const [values, setValues] = useState<FieldValueMap>({})
  const [fieldErrors, setFieldErrors] = useState<FieldErrorMap>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isTogglingEnabled, setIsTogglingEnabled] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [pollingOpen, setPollingOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const applyDetail = useCallback((next: ConnectorDetail, options?: { resetForm?: boolean; autoExpand?: boolean }) => {
    setDetail(next)
    if (options?.resetForm ?? true) {
      setValues(initialFormValues(next))
    }
    if (options?.autoExpand === false) {
      return
    }
    // Auto-expand the polling section if it's already configured so the user
    // can see why those fields are populated.
    const config = next.config ?? {}
    if (config['wp_username'] || config['wp_application_password']) {
      setPollingOpen(true)
    }
    const pollInterval = Number(config['poll_interval_sec'] ?? '0')
    if (
      (Number.isFinite(pollInterval) && pollInterval > 0) ||
      (config['post_types'] && config['post_types'] !== 'page,post')
    ) {
      setAdvancedOpen(true)
    }
  }, [])

  const loadDetail = useCallback(async (options?: { resetForm?: boolean; autoExpand?: boolean }) => {
    const next = await connectorsApi.get(connectorId)
    applyDetail(next, options)
  }, [applyDetail, connectorId])

  useEffect(() => {
    let cancelled = false

    // eslint-disable-next-line react-hooks/set-state-in-effect -- Load request updates dialog state asynchronously from the connector API.
    void loadDetail()
      .catch((error: unknown) => {
        if (cancelled) return
        setFormError(getApiErrorMessage(error, 'Failed to load connector.'))
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [loadDetail])

  useEffect(() => {
    if (!open) return
    const interval = window.setInterval(() => {
      if (document.hidden) return
      void loadDetail({ resetForm: false, autoExpand: false }).catch(() => {})
    }, 15000)
    return () => window.clearInterval(interval)
  }, [loadDetail, open])

  const setFieldValue = useCallback((key: string, value: string) => {
    setValues((current) => ({ ...current, [key]: value }))
    setFieldErrors((current) => {
      if (!current[key]) return current
      const next = { ...current }
      delete next[key]
      return next
    })
    setFormError(null)
    setSuccessMessage(null)
  }, [])

  const applyValidationError = useCallback((error: ConnectorValidationError) => {
    const map: FieldErrorMap = {}
    for (const issue of error.fields) {
      map[issue.key] = issue.message
    }
    setFieldErrors(map)
    setFormError(error.message)
    // Pop open whichever group the failing field belongs to, so the user sees
    // the inline error instead of a generic message above a collapsed block.
    if (error.fields.some((field) => WORDPRESS_POLLING_KEYS.has(field.key))) {
      setPollingOpen(true)
    }
    if (error.fields.some((field) => WORDPRESS_ADVANCED_KEYS.has(field.key))) {
      setAdvancedOpen(true)
    }
  }, [])

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!detail) return

    setIsSaving(true)
    setFormError(null)
    setSuccessMessage(null)
    setFieldErrors({})

    const payload = buildSubmitPayload(detail.schema, values)

    try {
      const next = await connectorsApi.save(detail.id, payload)
      applyDetail(next)
      setSuccessMessage('Configuration saved.')
    } catch (error) {
      if (error instanceof ConnectorValidationError) {
        applyValidationError(error)
      } else if (error instanceof ConnectorConflictError) {
        setFormError(error.message)
      } else {
        setFormError(getApiErrorMessage(error, 'Failed to save configuration.'))
      }
    } finally {
      setIsSaving(false)
    }
  }

  const handleToggleEnabled = async () => {
    if (!detail) return

    setIsTogglingEnabled(true)
    setFormError(null)
    setSuccessMessage(null)
    setFieldErrors({})

    try {
      const next = detail.enabled
        ? await connectorsApi.disable(detail.id)
        : await connectorsApi.enable(detail.id)
      applyDetail(next)
      setSuccessMessage(next.enabled ? 'Connector enabled.' : 'Connector disabled.')
    } catch (error) {
      if (error instanceof ConnectorValidationError) {
        applyValidationError(error)
      } else if (error instanceof ConnectorConflictError) {
        setFormError(error.message)
      } else {
        setFormError(getApiErrorMessage(error, 'Failed to update connector state.'))
      }
    } finally {
      setIsTogglingEnabled(false)
    }
  }

  const handleSyncNow = async () => {
    if (!detail || !detail.enabled || !detail.supportsManualSync) return

    setIsSyncing(true)
    setFormError(null)
    setSuccessMessage(null)

    try {
      await connectorsApi.sync(detail.id)
      await loadDetail({ resetForm: false, autoExpand: false })
      setSuccessMessage('Sync started.')
    } catch (error) {
      await loadDetail({ resetForm: false, autoExpand: false }).catch(() => {})
      setFormError(getApiErrorMessage(error, 'Failed to run sync.'))
    } finally {
      setIsSyncing(false)
    }
  }

  const handleDialogChange = (next: boolean) => {
    if (!next && (isSaving || isTogglingEnabled || isSyncing)) return
    onOpenChange(next)
  }

  const renderField = (field: ConnectorConfigFieldDefinition): ReactNode => {
    const value = values[field.key] ?? ''
    const fieldId = `connector-field-${field.key}`
    const error = fieldErrors[field.key]

    if (field.type === 'generated_secret') {
      const stored = detail?.config?.[field.key] ?? ''
      return (
        <div key={field.key} className="space-y-1.5">
          <CopyValueField
            label={field.label}
            value={stored}
            ariaLabel={`Copy ${field.label.toLowerCase()}`}
          />
          {field.helpText ? <p className="text-xs text-muted-foreground">{field.helpText}</p> : null}
          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      )
    }

    const storedMask = field.type === 'secret' ? detail?.config?.[field.key] : undefined
    const hasStoredSecret = field.type === 'secret' && isMaskedSecret(storedMask)
    const placeholder =
      field.type === 'secret'
        ? hasStoredSecret
          ? storedMask ?? 'Stored. Enter a new value to replace.'
          : field.placeholder ?? 'Enter value'
        : field.placeholder

    const control = (() => {
      switch (field.type) {
        case 'select':
          return (
            <Select
              value={value}
              onValueChange={(next) => setFieldValue(field.key, next)}
              disabled={isSaving || isTogglingEnabled}
            >
              <SelectTrigger id={fieldId} className="w-full">
                <SelectValue placeholder={field.placeholder ?? 'Select an option'} />
              </SelectTrigger>
              <SelectContent>
                {(field.options ?? []).map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )
        case 'toggle':
          return (
            <Switch
              id={fieldId}
              checked={value === 'true'}
              onCheckedChange={(checked) => setFieldValue(field.key, checked ? 'true' : 'false')}
              disabled={isSaving || isTogglingEnabled}
            />
          )
        case 'secret':
          return (
            <Input
              id={fieldId}
              type="password"
              autoComplete="new-password"
              value={value}
              placeholder={placeholder}
              onChange={(event) => setFieldValue(field.key, event.target.value)}
              disabled={isSaving || isTogglingEnabled}
            />
          )
        case 'text':
        default:
          return (
            <Input
              id={fieldId}
              type="text"
              value={value}
              placeholder={placeholder}
              onChange={(event) => setFieldValue(field.key, event.target.value)}
              disabled={isSaving || isTogglingEnabled}
            />
          )
      }
    })()

    return (
      <div key={field.key} className="space-y-1.5">
        <Label htmlFor={fieldId}>
          {field.label}
          {field.required ? <span className="ml-1 text-destructive">*</span> : null}
        </Label>
        {control}
        {field.type === 'secret' && hasStoredSecret ? (
          <p className="text-xs text-muted-foreground">
            A value is stored. Leave blank to keep it, or enter a new value to replace it.
          </p>
        ) : null}
        {field.helpText ? <p className="text-xs text-muted-foreground">{field.helpText}</p> : null}
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    )
  }

  const statusBadge = useMemo(() => {
    if (!detail) return null
    if (detail.errorStatus) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
          <AlertCircle className="h-3 w-3" />
          {formatConnectorErrorStatus(detail.errorStatus)}
        </span>
      )
    }
    if (detail.enabled) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-3 w-3" />
          Enabled
        </span>
      )
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
        Disabled
      </span>
    )
  }, [detail])

  const isWordpress = detail?.id === 'wordpress'
  const generatedSecretFields = useMemo(
    () => detail?.schema.filter((field) => field.type === 'generated_secret') ?? [],
    [detail],
  )
  const editableFields = useMemo(
    () => detail?.schema.filter((field) => field.type !== 'generated_secret') ?? [],
    [detail],
  )
  const groups: FieldGroup | null = useMemo(
    () => (isWordpress && editableFields.length > 0 ? groupWordpressFields(editableFields) : null),
    [editableFields, isWordpress],
  )

  return (
    <Dialog open={open} onOpenChange={handleDialogChange}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            {detail?.name ?? 'Connector setup'}
            {statusBadge}
          </DialogTitle>
          <DialogDescription>
            {detail?.description ?? 'Configure how this connector ingests content into your knowledge base.'}
          </DialogDescription>
        </DialogHeader>

        {context ? <div className="px-6 pt-4">{context}</div> : null}

        {isLoading ? (
          <div className="flex h-48 items-center justify-center">
            <LogoSpinner imageClassName="h-7 w-7" />
          </div>
        ) : !detail ? (
          <p className="px-6 py-8 text-center text-sm text-destructive">
            {formError ?? 'Connector unavailable.'}
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
            <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
              {isWordpress ? <WordpressSetupGuide /> : null}
              <ConnectorSyncStatus detail={detail} />
              <CopyValueField
                label="Webhook URL"
                value={detail.webhookUrl}
                ariaLabel="Copy webhook URL"
              />
              {generatedSecretFields.length > 0 ? (
                <div className="space-y-4">{generatedSecretFields.map(renderField)}</div>
              ) : null}
              {groups ? (
                <>
                  <div className="space-y-4">{groups.primary.map(renderField)}</div>
                  {groups.polling.length > 0 ? (
                    <Collapsible open={pollingOpen} onOpenChange={setPollingOpen}>
                      <CollapsibleTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-8 px-0 text-xs text-muted-foreground"
                        >
                          {pollingOpen ? (
                            <ChevronDown className="mr-1 h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="mr-1 h-3.5 w-3.5" />
                          )}
                          Can&apos;t install the plugin? Use REST polling instead
                        </Button>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="space-y-4 pt-2">
                        <p className="text-xs text-muted-foreground">
                          Some WordPress hosts (e.g. WordPress.com Free/Personal) don&apos;t allow
                          plugins. Provide an application password and Radioso will poll the REST API
                          on the interval set under Advanced.
                        </p>
                        {groups.polling.map(renderField)}
                      </CollapsibleContent>
                    </Collapsible>
                  ) : null}
                  {groups.advanced.length > 0 ? (
                    <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
                      <CollapsibleTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-8 px-0 text-xs text-muted-foreground"
                        >
                          {advancedOpen ? (
                            <ChevronDown className="mr-1 h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="mr-1 h-3.5 w-3.5" />
                          )}
                          Advanced
                        </Button>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="space-y-4 pt-2">
                        {groups.advanced.map(renderField)}
                      </CollapsibleContent>
                    </Collapsible>
                  ) : null}
                </>
              ) : (
                <div className="space-y-4">{editableFields.map(renderField)}</div>
              )}
              {formError ? (
                <p className="text-sm text-destructive" role="alert">
                  {formError}
                </p>
              ) : null}
              {successMessage ? (
                <p className="text-sm text-emerald-600 dark:text-emerald-400" role="status">
                  {successMessage}
                </p>
              ) : null}
            </div>
            <div className="flex flex-col-reverse gap-2 border-t px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
              <Button
                type="button"
                variant={detail.enabled ? 'outline' : 'secondary'}
                onClick={() => void handleToggleEnabled()}
                disabled={isSaving || isTogglingEnabled || isSyncing}
              >
                {isTogglingEnabled ? <Spinner className="mr-2" /> : null}
                {detail.enabled ? 'Disable' : 'Enable'}
              </Button>
              <div className="flex justify-end gap-2">
                {detail.supportsManualSync ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void handleSyncNow()}
                    disabled={
                      !detail.enabled ||
                      Boolean(detail.syncState.syncRequestedAt) ||
                      Boolean(detail.syncState.syncStartedAt) ||
                      isSaving ||
                      isTogglingEnabled ||
                      isSyncing
                    }
                  >
                    {isSyncing ? (
                      <Spinner className="mr-2" />
                    ) : (
                      <RefreshCw className="mr-2 h-4 w-4" />
                    )}
                    Sync now
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleDialogChange(false)}
                  disabled={isSaving || isTogglingEnabled || isSyncing}
                >
                  Close
                </Button>
                <Button type="submit" disabled={isSaving || isTogglingEnabled || isSyncing}>
                  {isSaving ? <Spinner className="mr-2" /> : null}
                  Save
                </Button>
              </div>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
