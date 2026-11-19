import { createHmac, timingSafeEqual } from 'node:crypto'

/** A delivery older or newer than this is a replay, or a clock too far off to trust. */
const TIMESTAMP_TOLERANCE_SECONDS = 60 * 60

/** Zapier prefixes request headers (all but Content-Type and Content-Length) with `Http-`, so look for both spellings. */
const header = (headers, name) => {
  const wanted = [name.toLowerCase(), `http-${name.toLowerCase()}`]
  for (const [key, value] of Object.entries(headers || {})) {
    if (wanted.includes(key.toLowerCase())) return Array.isArray(value) ? value[0] : value
  }
  return undefined
}

/** Why a push is not accepted, or null when it is authentic. Never includes the body or the secret. */
export const pushRejection = ({ rawRequest, secret, nowSeconds = Math.floor(Date.now() / 1000) }) => {
  const timestamp = header(rawRequest && rawRequest.headers, 'x-radioso-timestamp')
  const signature = header(rawRequest && rawRequest.headers, 'x-radioso-signature')
  if (typeof signature !== 'string' || typeof timestamp !== 'string') return 'no_signature'
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > TIMESTAMP_TOLERANCE_SECONDS) {
    return 'stale_timestamp'
  }
  return verifies({ rawRequest, secret, timestamp, signature }) ? null : 'bad_signature'
}

/**
 * `X-Radioso-Signature` is `sha256=` plus the hex HMAC-SHA256 of `"{timestamp}.{rawBody}"` under the
 * subscription's signing secret, the recipe the backend's `verifyWebhookSignature` signs with.
 * `nowSeconds` is injectable for tests. The window is an hour because Zapier can run `perform`
 * well after the push arrived; the per-event dedupe makes a replay harmless.
 */
const verifies = ({ rawRequest, secret, timestamp, signature }) => {
  const rawBody = rawRequest && rawRequest.content
  if (typeof rawBody !== 'string' || typeof secret !== 'string' || secret === '') return false
  if (!signature.startsWith('sha256=')) return false
  const actual = signature.slice('sha256='.length)
  if (!/^[a-f0-9]{64}$/i.test(actual)) return false
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest()
  return timingSafeEqual(Buffer.from(actual, 'hex'), expected)
}
