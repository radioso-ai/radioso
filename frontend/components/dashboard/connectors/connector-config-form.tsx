'use client'

import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Save } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import type { ConnectorDetail, ConnectorValidationIssue } from '@/lib/api'

interface ConnectorConfigFormProps {
  connector: ConnectorDetail
  busyAction: 'save' | 'enable' | 'disable' | null
  validationIssues: ConnectorValidationIssue[]
  formError: string | null
  onSave: (config: Record<string, string | boolean>) => Promise<void>
  onEnable: () => Promise<void>
  onDisable: () => Promise<void>
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

export function ConnectorConfigForm({
  connector,
  busyAction,
  validationIssues,
  formError,
  onSave,
  onEnable,
  onDisable,
}: ConnectorConfigFormProps) {
  const [values, setValues] = useState<Record<string, string>>(withDefaults(connector))
  const [dirty, setDirty] = useState(false)

  const issueByKey = new Map(validationIssues.map((issue) => [issue.key, issue.message]))

  const updateValue = (key: string, value: string | boolean) => {
    setValues((current) => ({ ...current, [key]: String(value) }))
    setDirty(true)
  }

  const buildPayload = () => {
    const payload: Record<string, string | boolean> = {}

    for (const field of connector.schema) {
      const value = values[field.key] ?? ''
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

  return (
    <div className="space-y-5 rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-semibold text-foreground">{connector.name}</h3>
            <Badge variant={connector.enabled ? 'default' : 'outline'}>
              {connector.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{connector.description}</p>
        </div>
      </div>

      {connector.errorStatus ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Connector error</AlertTitle>
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
            Register this callback URL with the provider after saving your connector config.
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          onClick={() => void onSave(buildPayload())}
          disabled={busyAction !== null || !dirty}
        >
          {busyAction === 'save' ? <Spinner className="mr-2" /> : <Save className="mr-2 h-4 w-4" />}
          Save Config
        </Button>

        {connector.enabled ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => void onDisable()}
            disabled={busyAction !== null}
          >
            {busyAction === 'disable' ? <Spinner className="mr-2" /> : null}
            Disable
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            onClick={() => void onEnable()}
            disabled={busyAction !== null}
          >
            {busyAction === 'enable' ? <Spinner className="mr-2" /> : null}
            Enable
          </Button>
        )}
      </div>
    </div>
  )
}
