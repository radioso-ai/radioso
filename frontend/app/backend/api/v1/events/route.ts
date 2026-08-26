import { proxyRealtimeEvents } from '@/lib/realtime-upstream'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = proxyRealtimeEvents
export const HEAD = proxyRealtimeEvents
export const OPTIONS = proxyRealtimeEvents
export const POST = proxyRealtimeEvents
export const PUT = proxyRealtimeEvents
export const PATCH = proxyRealtimeEvents
export const DELETE = proxyRealtimeEvents
