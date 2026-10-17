import { renderLlmsTxt } from '@/lib/content-index'

export const dynamic = 'force-static'

export async function GET() {
  return new Response(await renderLlmsTxt(), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
