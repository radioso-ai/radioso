export const runtime = 'nodejs'
export const dynamic = 'force-static'

export async function GET() {
  return new Response(
    'console.warn("Radioso website embed is not included in this build.");\n',
    {
      status: 404,
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    },
  )
}
