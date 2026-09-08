export const dynamic = 'force-dynamic'

export function GET() {
  return Response.json(
    {
      mcpUrl: process.env.RADIOSO_MCP_PUBLIC_URL ?? '',
      operatorMcpUrl: process.env.RADIOSO_OPERATOR_MCP_PUBLIC_URL ?? '',
      publicApiUrl: process.env.RADIOSO_PUBLIC_API_URL ?? '',
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
