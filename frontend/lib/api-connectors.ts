import { API_BASE, requireWorkspaceApiToken, request } from './api-client'

export type ConnectorConfigFieldType = 'text' | 'secret' | 'generated_secret' | 'toggle' | 'select'

export interface ConnectorConfigFieldDefinition {
  key: string
  label: string
  helpText?: string
  placeholder?: string
  type: ConnectorConfigFieldType
  required: boolean
  defaultValue?: string
  options?: Array<{ value: string; label: string }>
}

export interface ConnectorSummary {
  id: string
  name: string
  description: string
  enabled: boolean
  errorStatus: string | null
  supportsManualSync: boolean
}

export interface ConnectorSyncState {
  backfillCompletedAt: string | null
  syncRequestedAt: string | null
  syncStartedAt: string | null
  lastRunAt: string | null
  lastModifiedAt: string | null
  lastIngestedCount: number | null
  lastError: string | null
}

export interface ConnectorDetail extends ConnectorSummary {
  schema: ConnectorConfigFieldDefinition[]
  config: Record<string, string>
  webhookUrl: string
  syncState: ConnectorSyncState
}

export interface ConnectorValidationIssue {
  key: string
  message: string
}

export class ConnectorValidationError extends Error {
  readonly fields: ConnectorValidationIssue[]
  constructor(message: string, fields: ConnectorValidationIssue[]) {
    super(message)
    this.name = 'ConnectorValidationError'
    this.fields = fields
  }
}

export class ConnectorConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectorConflictError'
  }
}

const buildConnectorError = async (response: Response): Promise<Error> => {
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    // ignore
  }

  if (
    response.status === 400 &&
    payload &&
    typeof payload === 'object' &&
    'fields' in payload &&
    Array.isArray((payload as { fields: unknown }).fields)
  ) {
    const body = payload as { error?: string; fields: ConnectorValidationIssue[] }
    return new ConnectorValidationError(body.error ?? 'Validation failed', body.fields)
  }

  if (
    response.status === 409 &&
    payload &&
    typeof payload === 'object'
  ) {
    const body = payload as { error?: string; detail?: string }
    return new ConnectorConflictError(body.detail ?? body.error ?? 'Conflict')
  }

  const message =
    payload &&
    typeof payload === 'object' &&
    'error' in payload &&
    typeof (payload as { error: unknown }).error === 'string'
      ? ((payload as { error: string }).error)
      : `Request failed with status ${response.status}`
  return new Error(message)
}

const connectorMutation = async (path: string, init: RequestInit): Promise<ConnectorDetail> => {
  const token = await requireWorkspaceApiToken()
  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json')
  }
  if (!headers.has('X-Forwarded-Prefix')) {
    headers.set('X-Forwarded-Prefix', '/backend')
  }
  headers.set('Authorization', `Bearer ${token}`)

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    cache: 'no-store',
    headers,
    credentials: 'omit',
  })

  if (response.ok) {
    return (await response.json()) as ConnectorDetail
  }

  throw await buildConnectorError(response)
}

export const connectorsApi = {
  async list(): Promise<{ connectors: ConnectorSummary[] }> {
    return request<{ connectors: ConnectorSummary[] }>('/connectors', {
      method: 'GET',
    }, { withApiToken: true })
  },

  async get(connectorId: string): Promise<ConnectorDetail> {
    return request<ConnectorDetail>(`/connectors/${encodeURIComponent(connectorId)}`, {
      method: 'GET',
    }, { withApiToken: true })
  },

  async save(connectorId: string, config: Record<string, string>): Promise<ConnectorDetail> {
    return connectorMutation(`/connectors/${encodeURIComponent(connectorId)}`, {
      method: 'PUT',
      body: JSON.stringify({ config }),
    })
  },

  async enable(connectorId: string): Promise<ConnectorDetail> {
    return connectorMutation(`/connectors/${encodeURIComponent(connectorId)}/enable`, {
      method: 'POST',
    })
  },

  async disable(connectorId: string): Promise<ConnectorDetail> {
    return connectorMutation(`/connectors/${encodeURIComponent(connectorId)}/disable`, {
      method: 'POST',
    })
  },

  async sync(connectorId: string): Promise<{ accepted: boolean }> {
    const token = await requireWorkspaceApiToken()
    const response = await fetch(`${API_BASE}/connectors/${encodeURIComponent(connectorId)}/sync`, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    if (!response.ok) {
      throw await buildConnectorError(response)
    }
    return (await response.json()) as { accepted: boolean }
  },
}
