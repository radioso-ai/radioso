export const buildConverseClientConfig = (mcpUrl: string, token: string) =>
  JSON.stringify(
    {
      mcpServers: {
        radioso: {
          url: mcpUrl,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      },
    },
    null,
    2,
  )
