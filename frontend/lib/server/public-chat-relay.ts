/**
 * What the public chat proxy routes share when they relay a page's request to the backend: the
 * page's origin, the forwarding facts the backend resolves the app origin from, the visitor's
 * session headers and cookies, and the CORS headers a cross-origin page needs. Whether a page may
 * read an answer is the backend's decision, which the routes pass on.
 */

const ANONYMOUS_SESSION_HEADER = 'x-radioso-anonymous-session'
const PUBLIC_SESSION_HEADER = 'x-radioso-public-session'

const PUBLIC_CHAT_CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'OPTIONS, POST',
  'Access-Control-Allow-Headers': 'Content-Type, X-Radioso-Public-Session',
  Vary: 'Origin',
}

/** The code a relay answers with when the backend cannot be reached. */
export const PUBLIC_CHAT_RELAY_UNAVAILABLE_CODE = 'upstream_unavailable'

export const resolveRequestOrigin = (value: string | null): string | null => {
  if (!value) return null
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

const firstHeaderValue = (value: string | null) => value?.split(',')[0]?.trim() || null

/** The host and protocol the page called, so the backend can tell its own origin from the page's. */
export const forwardingHeaders = (request: Request): Record<string, string> => {
  const url = new URL(request.url)
  return {
    'X-Forwarded-Prefix': '/backend',
    'X-Forwarded-Host': firstHeaderValue(request.headers.get('x-forwarded-host'))
      ?? firstHeaderValue(request.headers.get('host'))
      ?? url.host,
    'X-Forwarded-Proto': firstHeaderValue(request.headers.get('x-forwarded-proto')) ?? url.protocol.replace(/:$/, ''),
  }
}

/** The page's origin, cookies and visitor session headers, as the backend's public session check reads them. */
export const visitorSessionHeaders = (request: Request): Record<string, string> => {
  const origin = resolveRequestOrigin(request.headers.get('origin'))
  const cookie = request.headers.get('cookie')
  const anonymousSession = request.headers.get(ANONYMOUS_SESSION_HEADER)
  const publicSession = request.headers.get(PUBLIC_SESSION_HEADER)
  return {
    ...(origin ? { Origin: origin } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
    ...(anonymousSession ? { 'X-Radioso-Anonymous-Session': anonymousSession } : {}),
    ...(publicSession ? { 'X-Radioso-Public-Session': publicSession } : {}),
  }
}

/** The visitor session the backend set or confirmed, passed back to the page. */
export const relayVisitorSessionHeaders = (upstream: Headers, target: Headers): void => {
  const anonymousSession = upstream.get(ANONYMOUS_SESSION_HEADER)
  if (anonymousSession) target.set('X-Radioso-Anonymous-Session', anonymousSession)
  const setCookie = upstream.get('set-cookie')
  if (setCookie) target.set('Set-Cookie', setCookie)
}

/** The public chat CORS headers, admitting `allowOrigin` when there is one. */
export const withPublicChatCorsHeaders = (headers: HeadersInit | undefined, allowOrigin: string | null): Headers => {
  const nextHeaders = new Headers(headers)
  Object.entries(PUBLIC_CHAT_CORS_HEADERS).forEach(([key, value]) => nextHeaders.set(key, value))
  if (allowOrigin) nextHeaders.set('Access-Control-Allow-Origin', allowOrigin)
  return nextHeaders
}

/** The preflight a page's public chat request needs: it sends JSON and the public session header. */
export const publicChatPreflight = (request: Request): Response =>
  new Response(null, {
    status: 204,
    headers: withPublicChatCorsHeaders(undefined, resolveRequestOrigin(request.headers.get('origin'))),
  })
