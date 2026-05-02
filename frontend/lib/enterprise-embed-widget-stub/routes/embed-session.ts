export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const unavailable = () =>
  Response.json(
    {
      error: {
        code: 'embed_not_available',
        message: 'Website embed is not included in this build.',
      },
    },
    { status: 404 },
  )

export async function OPTIONS() {
  return new Response(null, { status: 204 })
}

export async function POST() {
  return unavailable()
}
