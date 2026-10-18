export const buildConverseClientConfig = (mcpUrl: string, token?: string) =>
  JSON.stringify(
    {
      mcpServers: {
        radioso: {
          url: mcpUrl,
          ...(token ? {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          } : {}),
        },
      },
    },
    null,
    2,
  )
