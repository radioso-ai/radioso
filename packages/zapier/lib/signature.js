import { createHmac, timingSafeEqual } from 'node:crypto'

/** A delivery older or newer than this is a replay, or a clock too far off to trust. */
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60

const header = (headers, name) => {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value
  }
  return undefined
}

/**
 * Checks a Radioso push: `X-Radioso-Signature` is `sha256=` plus the hex HMAC-SHA256 of
 * `"{timestamp}.{rawBody}"` under the subscription's signing secret, the recipe the backend's
 * `verifyWebhookSignature` signs with. `nowSeconds` is injectable for tests.
 */
export const isAuthenticPush = ({ rawRequest, secret, nowSeconds = Math.floor(Date.now() / 1000) }) => {
  const rawBody = rawRequest && rawRequest.content
  const timestamp = header(rawRequest && rawRequest.headers, 'x-radioso-timestamp')
  const signature = header(rawRequest && rawRequest.headers, 'x-radioso-signature')
  if (typeof rawBody !== 'string' || typeof secret !== 'string' || secret === '') return false
  if (typeof timestamp !== 'string' || !/^\d{1,12}$/.test(timestamp)) return false
  if (Math.abs(nowSeconds - Number(timestamp)) > TIMESTAMP_TOLERANCE_SECONDS) return false
  if (typeof signature !== 'string' || !signature.startsWith('sha256=')) return false
  const actual = signature.slice('sha256='.length)
  if (!/^[a-f0-9]{64}$/i.test(actual)) return false
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest()
  return timingSafeEqual(Buffer.from(actual, 'hex'), expected)
}
