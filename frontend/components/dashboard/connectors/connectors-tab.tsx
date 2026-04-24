'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

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
import { getApiErrorMessage } from '@/lib/api-error'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'

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

export function ConnectorsTab({
  accountId,
  routeState,
}: {
  accountId: string
  routeState: DashboardRouteState
}) {
  const router = useRouter()
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
    const requestedConnectorId = routeState.connectorId
    const resolvedConnectorId = list.some((connector) => connector.id === requestedConnectorId)
      ? requestedConnectorId ?? null
      : list[0]?.id ?? null
    setConnectors(list)
    setSelectedConnectorId(resolvedConnectorId)
    return list
  }, [routeState.connectorId])

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
        const resolvedConnectorId = list.some((connector) => connector.id === routeState.connectorId)
          ? routeState.connectorId ?? null
          : list[0]?.id ?? null

        if (resolvedConnectorId) {
          await loadDetail(resolvedConnectorId)
        }
      } catch (error) {
        setFormError(getApiErrorMessage(error, 'Failed to load connectors.'))
      } finally {
        setIsLoading(false)
      }
    }

    void load()
  }, [loadConnectors, loadDetail, routeState.connectorId])

  useEffect(() => {
    if (routeState.settingsTab !== 'channels') {
      return
    }

    if (!connectors.length || !selectedConnectorId) {
      return
    }

    if (routeState.connectorId === selectedConnectorId) {
      return
    }

    router.replace(buildDashboardHref(accountId, {
      ...routeState,
      section: 'settings',
      settingsTab: 'channels',
      connectorId: selectedConnectorId,
    }))
  }, [accountId, connectors.length, routeState, router, selectedConnectorId])

  const selectConnector = async (connectorId: string) => {
    setSelectedConnectorId(connectorId)
    setFormError(null)
    setValidationIssues([])
    try {
      await loadDetail(connectorId)
      router.push(buildDashboardHref(accountId, {
        ...routeState,
        section: 'settings',
        settingsTab: 'channels',
        connectorId,
      }))
    } catch (error) {
      setFormError(getApiErrorMessage(error, 'Failed to load connector details.'))
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
      setFormError(getApiErrorMessage(error, `Failed to ${action} connector.`))
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
