'use client'

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { AlertCircle, CheckCircle2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
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
    const stored = detail.config?.[field.key]
    if (field.type === 'secret') {
      result[field.key] = ''
      continue
    }
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

export function ConnectorSetupDialog({
  open,
  connectorId,
  onOpenChange,
}: {
  open: boolean
  connectorId: string
  onOpenChange: (open: boolean) => void
}) {
  const [detail, setDetail] = useState<ConnectorDetail | null>(null)
  const [values, setValues] = useState<FieldValueMap>({})
  const [fieldErrors, setFieldErrors] = useState<FieldErrorMap>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isTogglingEnabled, setIsTogglingEnabled] = useState(false)

  useEffect(() => {
    let cancelled = false

    void connectorsApi
      .get(connectorId)
      .then((next) => {
        if (cancelled) return
        setDetail(next)
        setValues(initialFormValues(next))
      })
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
  }, [connectorId])

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
      setDetail(next)
      setValues(initialFormValues(next))
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
      setDetail(next)
      setValues(initialFormValues(next))
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

  const handleDialogChange = (next: boolean) => {
    if (!next && (isSaving || isTogglingEnabled)) return
    onOpenChange(next)
  }

  const renderField = (field: ConnectorConfigFieldDefinition) => {
    const value = values[field.key] ?? ''
    const fieldId = `connector-field-${field.key}`
    const error = fieldErrors[field.key]
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
          {detail.errorStatus}
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

  return (
    <Dialog open={open} onOpenChange={handleDialogChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {detail?.name ?? 'Connector setup'}
            {statusBadge}
          </DialogTitle>
          <DialogDescription>
            {detail?.description ?? 'Configure how this connector ingests content into your knowledge base.'}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex h-48 items-center justify-center">
            <LogoSpinner imageClassName="h-7 w-7" />
          </div>
        ) : !detail ? (
          <p className="py-8 text-center text-sm text-destructive">
            {formError ?? 'Connector unavailable.'}
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="mt-2 space-y-4">
            <CopyValueField
              label="Webhook URL"
              value={detail.webhookUrl}
              ariaLabel="Copy webhook URL"
            />
            <div className="space-y-4">
              {detail.schema.map(renderField)}
            </div>
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
            <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
              <Button
                type="button"
                variant={detail.enabled ? 'outline' : 'secondary'}
                onClick={() => void handleToggleEnabled()}
                disabled={isSaving || isTogglingEnabled}
              >
                {isTogglingEnabled ? <Spinner className="mr-2" /> : null}
                {detail.enabled ? 'Disable' : 'Enable'}
              </Button>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleDialogChange(false)}
                  disabled={isSaving || isTogglingEnabled}
                >
                  Close
                </Button>
                <Button type="submit" disabled={isSaving || isTogglingEnabled}>
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
