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
  const canonicalApiOrigin = publicApiUrl.trim().replace(/\/+$/u, '')
  const dashboardBase = dashboardOrigin.replace(/\/+$/u, '')

  return {
    endpoint,
    discoveryCardUrl: canonicalApiOrigin
      ? new URL(AGENT_CARD_PATH(publicId), canonicalApiOrigin).toString()
      : `${dashboardBase}/backend${AGENT_CARD_PATH(publicId)}`,
  }
}
