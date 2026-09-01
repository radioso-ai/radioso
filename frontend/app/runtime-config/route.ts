export const dynamic = 'force-dynamic'

export function GET() {
  return Response.json(
    { mcpUrl: process.env.RADIOSO_MCP_PUBLIC_URL ?? '' },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
