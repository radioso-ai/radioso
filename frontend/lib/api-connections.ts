import { request } from './api-client'

export type ApiConnectionAuthScheme = 'none' | 'bearer' | 'header' | 'basic'
export type ApiRequestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type ApiValueType = 'text' | 'number' | 'boolean' | 'date' | 'email'
export type ApiOutputFieldRole = 'key' | 'title' | 'subtitle' | 'image' | 'link'

export type ApiConnection = {
  id: string
  name: string
  baseUrl: string
  authScheme: ApiConnectionAuthScheme
  authHeaderName: string | null
  /** The credential's masked tail; the credential itself is never returned. */
  credentialMask: string | null
  defaultHeaders: Record<string, string>
  createdAt: string
  updatedAt: string
}

export type ApiConnectionInput = {
  name: string
  baseUrl: string
  authScheme: ApiConnectionAuthScheme
  authHeaderName?: string | null
  /** Write-only: omitted on an update to keep the stored one. */
  credential?: string
  defaultHeaders: Record<string, string>
}

export type ApiScalarOutput = {
  path: string
  type: ApiValueType
  description?: string
  required: boolean
}

/** A list item's field: never required, since only a top-level output can fail the skill when absent. */
export type ApiListField = Omit<ApiScalarOutput, 'required'> & { role?: ApiOutputFieldRole }

export type ApiListOutput = {
  path: string
  type: 'list'
  description?: string
  required: boolean
  maxItems: number
  fields: Record<string, ApiListField>
}

export type ApiOutputDeclaration = ApiScalarOutput | ApiListOutput

export type ApiRequestTestInput = {
  method: ApiRequestMethod
  path: string
  boundParams: Record<string, unknown>
  exposedSampleValues: Record<string, unknown>
  outputs: Record<string, ApiOutputDeclaration>
}

export type ApiRequestTestResult = {
  httpStatus: number | null
  durationMs: number
  outcome: string
  reason?: string
  outputs: Record<string, unknown>
  mismatches: string[]
  body: unknown
  bodyTruncated: boolean
}

const base = '/settings/api-connections'

export const apiConnectionsApi = {
  async list(): Promise<ApiConnection[]> {
    const response = await request<{ connections: ApiConnection[] }>(base, { method: 'GET' }, { withSession: true })
    return response.connections
  },

  async create(input: ApiConnectionInput): Promise<ApiConnection> {
    const response = await request<{ connection: ApiConnection }>(
      base,
      { method: 'POST', body: JSON.stringify(input) },
      { withSession: true },
    )
    return response.connection
  },

  async update(connectionId: string, input: Partial<ApiConnectionInput>): Promise<ApiConnection> {
    const response = await request<{ connection: ApiConnection }>(
      `${base}/${connectionId}`,
      { method: 'PATCH', body: JSON.stringify(input) },
      { withSession: true },
    )
    return response.connection
  },

  async remove(connectionId: string): Promise<void> {
    await request<void>(`${base}/${connectionId}`, { method: 'DELETE' }, { withSession: true })
  },

  async testRequest(connectionId: string, input: ApiRequestTestInput): Promise<ApiRequestTestResult> {
    return request<ApiRequestTestResult>(
      `${base}/${connectionId}/test-request`,
      { method: 'POST', body: JSON.stringify(input) },
      { withSession: true },
    )
  },
}
