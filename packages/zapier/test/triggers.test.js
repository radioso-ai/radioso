import { createHmac } from 'node:crypto'

import nock from 'nock'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import zapier from 'zapier-platform-core'

import App from '../index.js'
import { pushRejection } from '../lib/signature.js'

const appTester = zapier.createAppTester(App)
const ORIGIN = 'https://api.example'
const TOKEN = 'radioso_svc_v1_example'
const authData = { instance_url: ORIGIN, api_token: TOKEN }
const TARGET_URL = 'https://hooks.zapier.example/hooks/standard/1/abc/'
const SECRET = 'whsec_example_secret'
const SUBSCRIPTION_ID = '3b6f1c9e-2d84-4a07-8e5b-9c1d7a0f4e22'
const subscribeData = { id: SUBSCRIPTION_ID, signingSecret: SECRET }

const radioso = () => nock(ORIGIN, { reqheaders: { authorization: `Bearer ${TOKEN}` } })
const trigger = (key) => App.triggers[key].operation

const EVENT_KEYS = [
  'conversation_started',
  'contact_request_created',
  'handoff_requested',
  'routine_completed',
  'decision_pending',
  'document_processed',
  'document_failed',
]
const EVENT_TYPES = {
  conversation_started: 'conversation.started',
  contact_request_created: 'contact_request.created',
  handoff_requested: 'handoff.requested',
  routine_completed: 'routine.completed',
  decision_pending: 'decision.pending',
  document_processed: 'document.processed',
  document_failed: 'document.failed',
}

const sign = (secret, timestamp, rawBody) =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`

// Zapier's documented rawRequest: every header except Content-Type and Content-Length is prefixed `Http-`.
const push = ({ type = 'routine.completed', secret = SECRET, timestamp = Math.floor(Date.now() / 1000), tamper = false } = {}) => {
  const event = { id: 'e1', type, version: 1, occurredAt: '2026-01-15T10:30:00.000Z', workspaceId: 'w1', data: { conversationId: 'c1' } }
  const content = JSON.stringify(event)
  return {
    event,
    cleanedRequest: event,
    rawRequest: {
      method: 'POST',
      querystring: '',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(content.length),
        'Http-X-Radioso-Timestamp': String(timestamp),
        'Http-X-Radioso-Signature': sign(secret, timestamp, content),
        'Http-Idempotency-Key': 'e1',
      },
      content: tamper ? `${content} ` : content,
    },
  }
}

/** A stand-in for Zapier's `z` with its cache semantics (set only if absent) and a console that records drops. */
const fakeZ = () => {
  const claimed = new Set()
  const logs = []
  return {
    logs,
    console: { log: (line) => logs.push(line) },
    cache: {
      set: vi.fn(async (key, _value, _ttl, _scope, nx) => {
        if (nx && claimed.has(key)) return false
        claimed.add(key)
        return true
      }),
    },
  }
}
const receive = (key, bundle, z = fakeZ()) => trigger(key).perform(z, { authData, subscribeData, ...bundle })

beforeAll(() => {
  nock.disableNetConnect()
})

afterEach(() => {
  expect(nock.pendingMocks()).toEqual([])
  nock.cleanAll()
})

describe('subscribing', () => {
  it('registers the target URL for one event type and keeps the id and signing secret', async () => {
    radioso()
      .post('/api/v1/workspace/event-subscriptions', { targetUrl: TARGET_URL, eventTypes: ['routine.completed'], label: 'zapier' })
      .reply(201, { subscription: { id: SUBSCRIPTION_ID, status: 'active' }, signingSecret: SECRET })
    const result = await appTester(trigger('routine_completed').performSubscribe, { authData, targetUrl: TARGET_URL })
    expect(result).toEqual(subscribeData)
  })

  it('surfaces the API error when the subscription cap is reached', async () => {
    radioso()
      .post('/api/v1/workspace/event-subscriptions')
      .reply(409, { error: { code: 'event_subscription_limit_reached', message: 'Too many subscriptions' } })
    await expect(appTester(trigger('handoff_requested').performSubscribe, { authData, targetUrl: TARGET_URL })).rejects.toThrow(
      /Too many subscriptions/,
    )
  })

  it('says so when the instance has no subscriptions API', async () => {
    radioso().post('/api/v1/workspace/event-subscriptions').reply(404, { error: { code: 'not_found', message: 'Not found' } })
    await expect(appTester(trigger('routine_completed').performSubscribe, { authData, targetUrl: TARGET_URL })).rejects.toThrow(
      /does not support event triggers/,
    )
  })

  it('deletes the subscription by the stored id', async () => {
    radioso().delete(`/api/v1/workspace/event-subscriptions/${SUBSCRIPTION_ID}`).reply(204)
    await appTester(trigger('routine_completed').performUnsubscribe, { authData, subscribeData })
  })

  it('treats a subscription that is already gone as unsubscribed', async () => {
    radioso()
      .delete(`/api/v1/workspace/event-subscriptions/${SUBSCRIPTION_ID}`)
      .reply(404, { error: { code: 'not_found', message: 'Not found' } })
    await appTester(trigger('routine_completed').performUnsubscribe, { authData, subscribeData })
  })

  it('sends nothing when there is no stored subscription', async () => {
    await appTester(trigger('routine_completed').performUnsubscribe, { authData, subscribeData: undefined })
  })
})

describe('receiving a push', () => {
  it('hands a correctly signed event to the Zap, keyed by the event id', async () => {
    const { event, rawRequest, cleanedRequest } = push()
    const result = await receive('routine_completed', { rawRequest, cleanedRequest })
    expect(result).toEqual([event])
    expect(result[0].id).toBe('e1')
  })

  it('accepts unprefixed header names as well', async () => {
    const { event, rawRequest } = push()
    rawRequest.headers = {
      'x-radioso-timestamp': rawRequest.headers['Http-X-Radioso-Timestamp'],
      'X-Radioso-Signature': rawRequest.headers['Http-X-Radioso-Signature'],
    }
    expect(await receive('routine_completed', { rawRequest })).toEqual([event])
  })

  const dropped = [
    ['a body that was altered', () => push({ tamper: true }), undefined, 'bad_signature'],
    ['another secret', () => push({ secret: 'whsec_other' }), undefined, 'bad_signature'],
    ['no stored signing secret', () => push(), { subscribeData: {} }, 'bad_signature'],
    [
      'no signature',
      () => {
        const request = push()
        delete request.rawRequest.headers['Http-X-Radioso-Signature']
        return request
      },
      undefined,
      'no_signature',
    ],
    ['a stale timestamp', () => push({ timestamp: Math.floor(Date.now() / 1000) - 3700 }), undefined, 'stale_timestamp'],
    ["another type's event", () => push({ type: 'handoff.requested' }), undefined, 'type_mismatch'],
  ]
  it.each(dropped)('drops a push with %s and logs why, without the secret or body', async (_name, make, extra, reason) => {
    const z = fakeZ()
    const { rawRequest } = make()
    expect(await receive('routine_completed', { rawRequest, ...extra }, z)).toEqual([])
    expect(z.logs).toEqual([`radioso push dropped: ${reason}`])
    expect(z.logs.join()).not.toContain(SECRET)
  })

  it('drops a signed body that is not JSON', async () => {
    const z = fakeZ()
    const timestamp = Math.floor(Date.now() / 1000)
    const rawRequest = {
      headers: { 'Http-X-Radioso-Timestamp': String(timestamp), 'Http-X-Radioso-Signature': sign(SECRET, timestamp, 'not json') },
      content: 'not json',
    }
    expect(await receive('routine_completed', { rawRequest }, z)).toEqual([])
    expect(z.logs).toEqual(['radioso push dropped: bad_json'])
  })

  it('runs the Zap once when Radioso retries the same event', async () => {
    const z = fakeZ()
    const { rawRequest } = push()
    expect(await receive('routine_completed', { rawRequest }, z)).toHaveLength(1)
    expect(await receive('routine_completed', { rawRequest }, z)).toEqual([])
    expect(z.logs).toEqual(['radioso push dropped: duplicate'])
    expect(z.cache.set).toHaveBeenCalledWith(`${SUBSCRIPTION_ID}:e1`, true, 172800, null, true)
  })

  it('delivers rather than loses an event when the cache is unavailable', async () => {
    const z = fakeZ()
    z.cache.set = async () => {
      throw new Error('rpc is not available')
    }
    const { event, rawRequest } = push()
    expect(await receive('routine_completed', { rawRequest }, z)).toEqual([event])
  })
})

describe('signature check', () => {
  const now = 1_767_225_600
  const body = '{"id":"e1","type":"routine.completed"}'
  // Computed with the backend's signedWebhook recipe: HMAC-SHA256 over "{timestamp}.{rawBody}".
  const KNOWN_DIGEST = 'ab83d1c69fc6abfedd5e2108a9f3c3e40d812929f2908b881fa6582de35d3f50'
  const request = (timestamp, digest = KNOWN_DIGEST) => ({
    headers: { 'Http-X-Radioso-Timestamp': String(timestamp), 'Http-X-Radioso-Signature': `sha256=${digest}` },
    content: body,
  })
  const check = (rawRequest) => pushRejection({ rawRequest, secret: SECRET, nowSeconds: now })

  it('accepts the known vector', () => {
    expect(check(request(now))).toBeNull()
  })

  it('rejects a different or malformed digest', () => {
    expect(check(request(now, 'a'.repeat(64)))).toBe('bad_signature')
    expect(check(request(now, 'short'))).toBe('bad_signature')
  })

  it('accepts a timestamp up to an hour off and rejects more', () => {
    const signed = (timestamp) => ({
      headers: { 'Http-X-Radioso-Timestamp': String(timestamp), 'Http-X-Radioso-Signature': sign(SECRET, timestamp, body) },
      content: body,
    })
    expect(check(signed(now - 3600))).toBeNull()
    expect(check(signed(now - 3601))).toBe('stale_timestamp')
    expect(check(signed(now + 3601))).toBe('stale_timestamp')
  })
})

describe('sample data', () => {
  const events = [
    { id: 'old', type: 'routine.completed', version: 1, occurredAt: '2026-01-01T00:00:00.000Z', workspaceId: 'w', data: {} },
    { id: 'new', type: 'routine.completed', version: 1, occurredAt: '2026-01-03T00:00:00.000Z', workspaceId: 'w', data: {} },
  ]

  it('lists the three newest events of the type, newest first', async () => {
    radioso()
      .get('/api/v1/workspace/events')
      .query({ types: 'routine.completed', limit: '3' })
      .reply(200, { events, nextCursor: 'c', hasMore: false })
    const result = await appTester(trigger('routine_completed').performList, { authData })
    expect(result.map((event) => event.id)).toEqual(['new', 'old'])
  })

  it.each(EVENT_KEYS)('%s: the sample matches its type and every output field', (key) => {
    const { sample, outputFields } = trigger(key)
    expect(sample.type).toBe(EVENT_TYPES[key])
    for (const { key: path } of outputFields) {
      const [head, ...rest] = path.split('__')
      expect(rest.length === 0 ? sample : sample[head], path).toBeDefined()
      if (rest.length > 0) expect(Object.keys(sample[head]), path).toContain(rest[0])
    }
  })

  it('names the document, not a conversation, on the document triggers', () => {
    for (const key of ['document_processed', 'document_failed']) {
      const { sample, outputFields } = trigger(key)
      const keys = outputFields.map((field) => field.key)
      expect(keys).toEqual(
        expect.arrayContaining(['data__documentId', 'data__revision', 'data__title', 'data__contentKind', 'data__sourceKind', 'data__sourceId']),
      )
      expect(keys).not.toContain('data__conversationId')
      expect(Object.keys(sample.data)).not.toContain('conversationId')
    }
    expect(trigger('document_failed').outputFields.map((field) => field.key)).toContain('data__failureCode')
  })

  it('subscribes a document trigger to its own type', async () => {
    radioso()
      .post('/api/v1/workspace/event-subscriptions', { targetUrl: TARGET_URL, eventTypes: ['document.failed'], label: 'zapier' })
      .reply(201, { subscription: { id: SUBSCRIPTION_ID }, signingSecret: SECRET })
    const result = await appTester(trigger('document_failed').performSubscribe, { authData, targetUrl: TARGET_URL })
    expect(result).toEqual(subscribeData)
  })

  it('uses a channel value the backend emits', () => {
    expect(trigger('conversation_started').sample.data.channel).toBe('website_embed')
  })

  it('keeps the version and workspace out of the listed output fields', () => {
    for (const key of EVENT_KEYS) {
      const keys = trigger(key).outputFields.map((field) => field.key)
      expect(keys).not.toContain('version')
      expect(keys).not.toContain('workspaceId')
    }
  })
})
