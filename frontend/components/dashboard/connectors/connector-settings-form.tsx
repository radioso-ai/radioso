'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { getApiErrorMessage } from '@/lib/api-error'
import type { ConnectorDetail, ConnectorValidationIssue } from '@/lib/api'

interface ConnectorSettingsFormProps {
  connector: ConnectorDetail
  onSave: (config: Record<string, string | boolean>) => Promise<ConnectorDetail>
  onSaveStateChange?: (input: {
    state: 'idle' | 'saved' | 'saving' | 'error'
    message?: string | null
  }) => void
}

const withDefaults = (connector: ConnectorDetail): Record<string, string> => {
  const nextValues: Record<string, string> = { ...connector.config }

  for (const field of connector.schema) {
    if (!(field.key in nextValues) && field.defaultValue) {
      nextValues[field.key] = field.defaultValue
    }
  }

  return nextValues
}

const getValidationIssues = (error: unknown): ConnectorValidationIssue[] => {
  if (
    error &&
    typeof error === 'object' &&
    'fields' in error &&
    Array.isArray(error.fields)
  ) {
    return error.fields.filter((field): field is ConnectorValidationIssue => {
      return (
        field &&
        typeof field === 'object' &&
        'key' in field &&
        'message' in field &&
        typeof field.key === 'string' &&
        typeof field.message === 'string'
      )
    })
  }

  return []
}

export function ConnectorSettingsForm({
  connector,
  onSave,
  onSaveStateChange,
}: ConnectorSettingsFormProps) {
  const [values, setValues] = useState<Record<string, string>>(withDefaults(connector))
  const [dirty, setDirty] = useState(false)
  const [busyAction, setBusyAction] = useState<'save' | 'enable' | 'disable' | null>(null)
  const [validationIssues, setValidationIssues] = useState<ConnectorValidationIssue[]>([])
  const [formError, setFormError] = useState<string | null>(null)
  const draftVersionRef = useRef(0)
  const saveSequenceRef = useRef(0)

  const issueByKey = new Map(validationIssues.map((issue) => [issue.key, issue.message]))

  useEffect(() => {
    if (!dirty) {
      setValues(withDefaults(connector))
    }
  }, [connector, dirty])

  const updateValue = (key: string, value: string | boolean) => {
    draftVersionRef.current += 1
    setValues((current) => ({ ...current, [key]: String(value) }))
    setDirty(true)
  }

  const buildPayload = (draftValues: Record<string, string>) => {
    const payload: Record<string, string | boolean> = {}

    for (const field of connector.schema) {
      const value = draftValues[field.key] ?? ''
      if (
        field.type === 'secret' &&
        value === (connector.config[field.key] ?? '') &&
        value.includes('*')
      ) {
        continue
      }

      if (field.type === 'toggle') {
        payload[field.key] = value === 'true'
        continue
      }

      payload[field.key] = value
    }

    return payload
  }

  const persistDraft = async (draftValues: Record<string, string>) => {
    setBusyAction('save')
    setFormError(null)
    setValidationIssues([])
    const updated = await onSave(buildPayload(draftValues))
    return updated
  }

  const valuesSignature = useMemo(() => JSON.stringify(values), [values])

  useEffect(() => {
    onSaveStateChange?.({ state: 'idle' })
  }, [onSaveStateChange])

  useEffect(() => {
    if (!dirty) {
      return
    }

    const saveId = saveSequenceRef.current + 1
    saveSequenceRef.current = saveId
    onSaveStateChange?.({ state: 'saving', message: null })

    const timeout = window.setTimeout(async () => {
      const draftVersionAtRequestStart = draftVersionRef.current
      try {
        const updated = await persistDraft(values)
        if (saveSequenceRef.current !== saveId) {
          return
        }
        if (draftVersionRef.current === draftVersionAtRequestStart) {
          setValues(withDefaults(updated))
          setDirty(false)
          onSaveStateChange?.({ state: 'saved', message: null })
        }
      } catch (error) {
        if (saveSequenceRef.current !== saveId) {
          return
        }
        setValidationIssues(getValidationIssues(error))
        setFormError(getApiErrorMessage(error, 'Failed to save connector settings.'))
        onSaveStateChange?.({ state: 'error', message: 'Failed to save connector settings' })
      } finally {
        if (saveSequenceRef.current === saveId) {
          setBusyAction(null)
        }
      }
    }, 700)

    return () => window.clearTimeout(timeout)
  }, [dirty, onSaveStateChange, values, valuesSignature])

  return (
    <div className="space-y-5">
      {connector.errorStatus ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Channel error</AlertTitle>
          <AlertDescription>{connector.errorStatus}</AlertDescription>
        </Alert>
      ) : null}

      {formError ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Request failed</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-4">
        {connector.schema.map((field) => {
          const value = values[field.key] ?? ''
          const fieldError = issueByKey.get(field.key)

          return (
            <div key={field.key} className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor={field.key} className="text-foreground">
                  {field.label}
                </Label>
                {field.required ? (
                  <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                    Required
                  </span>
                ) : null}
              </div>

              {field.type === 'select' ? (
                <Select value={value} onValueChange={(next) => updateValue(field.key, next)}>
                  <SelectTrigger id={field.key} className="w-full">
                    <SelectValue placeholder={field.placeholder ?? field.label} />
                  </SelectTrigger>
                  <SelectContent>
                    {(field.options ?? []).map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : field.type === 'toggle' ? (
                <div className="flex items-center justify-between rounded-md border border-border bg-muted/20 px-3 py-2">
                  <p className="text-sm text-muted-foreground">
                    {field.helpText ?? 'Toggle this setting'}
                  </p>
                  <Switch
                    checked={value === 'true'}
                    onCheckedChange={(checked) => updateValue(field.key, checked)}
                  />
                </div>
              ) : (
                <Input
                  id={field.key}
                  type={field.type === 'secret' ? 'password' : 'text'}
                  value={value}
                  placeholder={field.placeholder ?? field.label}
                  aria-invalid={fieldError ? true : undefined}
                  onChange={(event) => updateValue(field.key, event.target.value)}
                />
              )}

              {field.helpText ? (
                <p className="text-sm text-muted-foreground">
                  {field.helpText}
                  {field.type === 'secret'
                    ? ' Leave the masked value unchanged to keep the current secret.'
                    : ''}
                </p>
              ) : null}

              {fieldError ? (
                <p className="text-sm text-destructive">{fieldError}</p>
              ) : null}
            </div>
          )
        })}
      </div>

      {connector.webhookUrl ? (
        <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <CheckCircle2 className="h-4 w-4 text-primary" />
            Webhook URL
          </div>
          <Input readOnly value={connector.webhookUrl} />
          <p className="text-sm text-muted-foreground">
            Register this callback URL with the provider after saving your connector settings.
          </p>
        </div>
      ) : null}
    </div>
  )
}
