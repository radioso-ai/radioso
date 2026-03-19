'use client'

import { useCallback, useEffect, useState } from 'react'

import { ConnectorCard } from '@/components/dashboard/connectors/connector-card'
import { ConnectorConfigForm } from '@/components/dashboard/connectors/connector-config-form'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Spinner } from '@/components/ui/spinner'
import {
  connectorsApi,
  type ConnectorDetail,
  type ConnectorSummary,
  type ConnectorValidationIssue,
} from '@/lib/api'

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (
    error &&
    typeof error === 'object' &&
    'error' in error &&
    typeof error.error === 'string'
  ) {
    return error.error
  }

  if (
    error &&
    typeof error === 'object' &&
    'error' in error &&
    typeof error.error === 'object' &&
    error.error &&
    'message' in error.error &&
    typeof error.error.message === 'string'
  ) {
    return error.error.message
  }

  if (
    error &&
    typeof error === 'object' &&
    'detail' in error &&
    typeof error.detail === 'string'
  ) {
    return error.detail
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
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

export function ConnectorsTab() {
  const [connectors, setConnectors] = useState<ConnectorSummary[]>([])
  const [selectedConnectorId, setSelectedConnectorId] = useState<string | null>(null)
  const [selectedConnector, setSelectedConnector] = useState<ConnectorDetail | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isDetailLoading, setIsDetailLoading] = useState(false)
  const [busyAction, setBusyAction] = useState<'save' | 'enable' | 'disable' | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [validationIssues, setValidationIssues] = useState<ConnectorValidationIssue[]>([])

  const loadConnectors = useCallback(async () => {
    const list = await connectorsApi.listConnectors()
    setConnectors(list)
    setSelectedConnectorId((current) => current ?? list[0]?.id ?? null)
    return list
  }, [])

  const loadDetail = useCallback(async (connectorId: string) => {
    setIsDetailLoading(true)
    try {
      const detail = await connectorsApi.getConnector(connectorId)
      setSelectedConnector(detail)
    } finally {
      setIsDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    const load = async () => {
      try {
        const list = await loadConnectors()
        if (list[0]?.id) {
          await loadDetail(list[0].id)
        }
      } catch (error) {
        setFormError(getErrorMessage(error, 'Failed to load connectors.'))
      } finally {
        setIsLoading(false)
      }
    }

    void load()
  }, [loadConnectors, loadDetail])

  const selectConnector = async (connectorId: string) => {
    setSelectedConnectorId(connectorId)
    setFormError(null)
    setValidationIssues([])
    try {
      await loadDetail(connectorId)
    } catch (error) {
      setFormError(getErrorMessage(error, 'Failed to load connector details.'))
    }
  }

  const syncAfterMutation = async (detail: ConnectorDetail) => {
    setSelectedConnector(detail)
    const list = await connectorsApi.listConnectors()
    setConnectors(list)
  }

  const runAction = async (
    action: 'save' | 'enable' | 'disable',
    execute: () => Promise<ConnectorDetail>
  ) => {
    setBusyAction(action)
    setFormError(null)
    setValidationIssues([])

    try {
      const detail = await execute()
      await syncAfterMutation(detail)
    } catch (error) {
      setValidationIssues(getValidationIssues(error))
      setFormError(getErrorMessage(error, `Failed to ${action} connector.`))
    } finally {
      setBusyAction(null)
    }
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }

  if (connectors.length === 0) {
    return (
      <Alert>
        <AlertTitle>No connectors registered</AlertTitle>
        <AlertDescription>
          The backend has not registered any chat connectors yet.
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
      <div className="space-y-3">
        {connectors.map((connector) => (
          <ConnectorCard
            key={connector.id}
            connector={connector}
            isSelected={connector.id === selectedConnectorId}
            onSelect={(connectorId) => void selectConnector(connectorId)}
          />
        ))}
      </div>

      <div>
        {isDetailLoading || !selectedConnector ? (
          <div className="flex min-h-[320px] items-center justify-center rounded-xl border border-border bg-card">
            <Spinner className="h-6 w-6" />
          </div>
        ) : (
          <ConnectorConfigForm
            key={`${selectedConnector.id}:${selectedConnector.enabled}:${JSON.stringify(selectedConnector.config)}:${selectedConnector.errorStatus ?? ''}`}
            connector={selectedConnector}
            busyAction={busyAction}
            validationIssues={validationIssues}
            formError={formError}
            onSave={(config) =>
              runAction('save', () => connectorsApi.saveConnectorConfig(selectedConnector.id, config))
            }
            onEnable={() =>
              runAction('enable', () => connectorsApi.enableConnector(selectedConnector.id))
            }
            onDisable={() =>
              runAction('disable', () => connectorsApi.disableConnector(selectedConnector.id))
            }
          />
        )}
      </div>
    </div>
  )
}
