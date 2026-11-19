/**
 * The one place that knows how a Zapier step reaches the Radioso API: which origin, which
 * credential header, and how an API error becomes a Zapier error. Actions and searches pass a
 * path and a body; they never build URLs or headers themselves.
 */

const API_PREFIX = '/api/v1'

/** Accepts `https://api.radioso.ai`, with or without a trailing slash or a pasted `/api/v1`. */
const normalizeInstanceUrl = (raw) => {
  let url = String(raw || '').trim()
  // A loop rather than a regex: a long run of slashes must not cost quadratic time.
  while (url.endsWith('/')) url = url.slice(0, -1)
  if (url.endsWith(API_PREFIX)) url = url.slice(0, -API_PREFIX.length)
  while (url.endsWith('/')) url = url.slice(0, -1)
  return url
}

/** Zapier's cloud reaches only public HTTPS origins, so nothing else is accepted. */
const isHttpsInstanceUrl = (raw) => {
  try {
    const url = new URL(normalizeInstanceUrl(raw))
    return url.protocol === 'https:' && url.host !== ''
  } catch {
    return false
  }
}

/** The origin's host, used to label a connection when no workspace name was entered. */
export const instanceHost = (raw) => {
  try {
    return new URL(normalizeInstanceUrl(raw)).host
  } catch {
    return normalizeInstanceUrl(raw)
  }
}

const apiUrl = (authData, path) => `${normalizeInstanceUrl(authData.instance_url)}${API_PREFIX}${path}`

const errorFromResponse = (z, response) => {
  let message = `Radioso returned HTTP ${response.status}`
  let code = String(response.status)
  const error = response.data && response.data.error
  if (error && typeof error.message === 'string') {
    message = error.message
    if (typeof error.code === 'string') code = error.code
  }
  if (response.status === 401) {
    return new z.errors.ExpiredAuthError(message)
  }
  return new z.errors.Error(message, code, response.status)
}

/**
 * Sends one authenticated request. `bundle.authData` carries `instance_url` and `api_token`.
 * A non-2xx answer throws; a 404 can be tolerated by the caller with `allowNotFound`.
 */
export const radiosoRequest = async (z, bundle, { method = 'GET', path, params, body, allowNotFound = false, allowEmptyBody = false }) => {
  if (!isHttpsInstanceUrl(bundle.authData.instance_url)) {
    throw new z.errors.Error(
      'Instance URL must start with https://, for example https://api.radioso.ai.',
      'invalid_instance_url',
      400,
    )
  }
  const response = await z.request({
    method,
    url: apiUrl(bundle.authData, path),
    params,
    body,
    headers: {
      Authorization: `Bearer ${String(bundle.authData.api_token || '').trim()}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    skipThrowForStatus: true,
  })
  if (allowNotFound && response.status === 404) return null
  if (response.status >= 400) throw errorFromResponse(z, response)
  if (response.data === undefined && !allowEmptyBody) {
    throw new z.errors.Error(
      'Radioso did not answer with JSON. Set Instance URL to the URL your API answers on, for example https://api.radioso.ai or https://app.example.com/backend.',
      'invalid_instance_url',
      response.status,
    )
  }
  return response.data
}
