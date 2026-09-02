export interface RuntimeConfig {
  mcpUrl: string
  publicApiUrl: string
}

export const EMPTY_RUNTIME_CONFIG: RuntimeConfig = { mcpUrl: '', publicApiUrl: '' }

const readString = (body: Record<string, unknown>, key: string): string => {
  const value = body[key]
  return typeof value === 'string' ? value : ''
}

export const parseRuntimeConfig = (body: unknown): RuntimeConfig => {
  if (!body || typeof body !== 'object') return EMPTY_RUNTIME_CONFIG
  const record = body as Record<string, unknown>
  return {
    mcpUrl: readString(record, 'mcpUrl'),
    publicApiUrl: readString(record, 'publicApiUrl'),
  }
}

/** Path the public API is mounted at, behind the deployment's canonical API host. */
export const PUBLIC_API_PATH = '/api/v1'

/**
 * The deployment's canonical API base when it declares one, so the dashboard, SDK, and
 * docs teach the same URL. Otherwise the dashboard origin plus its proxy path, which is
 * what a local or single-host deployment actually serves.
 */
export const resolveApiBaseUrl = ({
  publicApiUrl,
  dashboardOrigin,
  basePath,
}: {
  publicApiUrl: string
  dashboardOrigin: string
  basePath: string
}): string => {
  const canonical = publicApiUrl.trim().replace(/\/+$/, '')
  if (!canonical) return `${dashboardOrigin}${basePath}`
  return canonical.endsWith(PUBLIC_API_PATH) ? canonical : `${canonical}${PUBLIC_API_PATH}`
}

export const buildAgentChatEndpoint = (apiBaseUrl: string, agentId: string): string =>
  `${apiBaseUrl}/agents/${agentId}/chat`
