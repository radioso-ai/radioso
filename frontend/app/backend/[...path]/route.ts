import { EDGE_FACTS_HEADERS } from '@radioso/edge-proof'

import { buildEdgeFactsHeaders } from '../../../lib/server/edge-facts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type ProxyContext = {
  params: Promise<{ path: string[] }>
}

const REQUEST_HEADER_BLACKLIST = new Set(['content-length', 'host'])
const RESPONSE_HEADER_BLACKLIST = new Set(['content-length'])

const getBackendBase = () => process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:8080'

const buildUpstreamUrl = (requestUrl: string, pathSegments: string[]) => {
  const incomingUrl = new URL(requestUrl)
  const backendBase = getBackendBase()
  const normalizedBase = backendBase.endsWith('/') ? backendBase : `${backendBase}/`
  const encodedPath = pathSegments.map((segment) => encodeURIComponent(segment)).join('/')
  const upstreamUrl = new URL(encodedPath, normalizedBase)

  upstreamUrl.search = incomingUrl.search
  return upstreamUrl
}

// The backend verifies the edge-facts proof against its own `req.method` and
// `req.originalUrl` without the query, so the proof signs exactly the method
// and pathname of the upstream URL. Client-supplied edge headers never pass
// through: only this proxy speaks for the edge.
const buildUpstreamHeaders = (request: Request, upstreamUrl: URL) => {
  const headers = new Headers(request.headers)

  REQUEST_HEADER_BLACKLIST.forEach((headerName) => headers.delete(headerName))
  Object.values(EDGE_FACTS_HEADERS).forEach((headerName) => headers.delete(headerName))

  if (!headers.has('x-forwarded-prefix')) {
    headers.set('x-forwarded-prefix', '/backend')
  }

  const edgeFactsHeaders = buildEdgeFactsHeaders(request, {
    method: request.method,
    path: upstreamUrl.pathname,
  })
  Object.entries(edgeFactsHeaders).forEach(([name, value]) => headers.set(name, value))

  return headers
}

const buildResponseHeaders = (upstream: Response) => {
  const headers = new Headers()

  upstream.headers.forEach((value, key) => {
    const normalizedKey = key.toLowerCase()
    if (RESPONSE_HEADER_BLACKLIST.has(normalizedKey) || normalizedKey === 'set-cookie') {
      return
    }

    headers.append(key, value)
  })

  if (typeof upstream.headers.getSetCookie === 'function') {
    for (const cookie of upstream.headers.getSetCookie()) {
      headers.append('set-cookie', cookie)
    }
  } else {
    const setCookie = upstream.headers.get('set-cookie')
    if (setCookie) {
      headers.append('set-cookie', setCookie)
    }
  }

  if (!headers.has('cache-control')) {
    headers.set('cache-control', 'no-store')
  }

  return headers
}

const buildUpstreamBody = async (request: Request) => {
  if (!request.body || request.method === 'GET' || request.method === 'HEAD') {
    return undefined
  }

  return request.arrayBuffer()
}

const proxy = async (request: Request, context: ProxyContext) => {
  const { path } = await context.params
  const upstreamUrl = buildUpstreamUrl(request.url, path)
  // Buffered before the headers are built, so a slow upload cannot age the
  // edge-facts proof's timestamp past the backend's freshness window.
  const body = await buildUpstreamBody(request)
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers: buildUpstreamHeaders(request, upstreamUrl),
    cache: 'no-store',
    redirect: 'manual',
  }

  if (body !== undefined) {
    init.body = body
  }

  try {
    const upstream = await fetch(upstreamUrl.toString(), init)

    return new Response(upstream.body, {
      status: upstream.status,
      headers: buildResponseHeaders(upstream),
    })
  } catch (error) {
    const message =
      error instanceof Error
        ? `Backend is unavailable: ${error.message}`
        : 'Backend is unavailable.'

    return Response.json(
      {
        error: {
          code: 'UPSTREAM_UNAVAILABLE',
          message,
        },
      },
      { status: 503 },
    )
  }
}

export const GET = proxy
export const HEAD = proxy
export const POST = proxy
export const PUT = proxy
export const PATCH = proxy
export const DELETE = proxy
export const OPTIONS = proxy
