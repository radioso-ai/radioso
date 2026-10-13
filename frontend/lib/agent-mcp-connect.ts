import { resolveApiBaseUrl } from '@/lib/runtime-config'

const AGENT_CARD_PATH = (publicId: string) => `/.well-known/agent-card/${encodeURIComponent(publicId)}.json`

export const buildAgentMcpConnectDetails = ({
  dashboardOrigin,
  mcpUrl,
  publicApiUrl,
  publicId,
}: {
  dashboardOrigin: string
  mcpUrl: string
  publicApiUrl: string
  publicId: string
}) => {
  const endpoint = `${mcpUrl.replace(/\/+$/u, '')}/a/${encodeURIComponent(publicId)}`
  const apiBaseUrl = resolveApiBaseUrl({
    publicApiUrl,
    dashboardOrigin,
    basePath: '/backend/api/v1',
  })

  return {
    endpoint,
    discoveryCardUrl: new URL(AGENT_CARD_PATH(publicId), apiBaseUrl).toString(),
  }
}
