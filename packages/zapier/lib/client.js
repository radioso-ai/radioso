'use strict'

/**
 * The one place that knows how a Zapier step reaches the Radioso API: which origin, which
 * credential header, and how an API error becomes a Zapier error. Actions and searches pass a
 * path and a body; they never build URLs or headers themselves.
 */

const API_PREFIX = '/api/v1'

/** Accepts `https://api.radioso.ai`, with or without a trailing slash or a pasted `/api/v1`. */
const normalizeInstanceUrl = (raw) => {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return ''
  return trimmed.replace(/\/+$/, '').replace(/\/api\/v1$/, '')
}

/** The origin's host, used to label a connection when no workspace name was entered. */
const instanceHost = (raw) => {
  try {
    return new URL(normalizeInstanceUrl(raw)).host
  } catch {
    return normalizeInstanceUrl(raw)
  }
}

const apiUrl = (bundle, path) => `${normalizeInstanceUrl(bundle.authData.instance_url)}${API_PREFIX}${path}`

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
const radiosoRequest = async (z, bundle, { method = 'GET', path, params, body, allowNotFound = false }) => {
  const response = await z.request({
    method,
    url: apiUrl(bundle, path),
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
  return response.data
}

module.exports = { instanceHost, normalizeInstanceUrl, radiosoRequest }
