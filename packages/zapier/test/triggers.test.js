import { createHmac } from 'node:crypto'

import nock from 'nock'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import zapier from 'zapier-platform-core'

import App from '../index.js'
import { isAuthenticPush } from '../lib/signature.js'

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
]
const EVENT_TYPES = {
  conversation_started: 'conversation.started',
  contact_request_created: 'contact_request.created',
  handoff_requested: 'handoff.requested',
  routine_completed: 'routine.completed',
  decision_pending: 'decision.pending',
}

const sign = (secret, timestamp, rawBody) =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`

const push = ({ type = 'routine.completed', secret = SECRET, timestamp = Math.floor(Date.now() / 1000), tamper = false } = {}) => {
  const event = { id: 'e1', type, version: 1, occurredAt: '2026-01-15T10:30:00.000Z', workspaceId: 'w1', data: { conversationId: 'c1' } }
  const content = JSON.stringify(event)
  return {
    event,
    rawRequest: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-radioso-timestamp': String(timestamp),
        'x-radioso-signature': sign(secret, timestamp, content),
      },
      content: tamper ? `${content} ` : content,
    },
  }
}

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
    const { event, rawRequest } = push()
    const result = await appTester(trigger('routine_completed').perform, { authData, subscribeData, rawRequest })
    expect(result).toEqual([event])
    expect(result[0].id).toBe('e1')
  })

  it('drops a push whose body was altered', async () => {
    const { rawRequest } = push({ tamper: true })
    expect(await appTester(trigger('routine_completed').perform, { authData, subscribeData, rawRequest })).toEqual([])
  })

  it('drops a push signed with another secret', async () => {
    const { rawRequest } = push({ secret: 'whsec_other' })
    expect(await appTester(trigger('routine_completed').perform, { authData, subscribeData, rawRequest })).toEqual([])
  })

  it('drops a push when no signing secret was stored', async () => {
    const { rawRequest } = push()
    expect(await appTester(trigger('routine_completed').perform, { authData, rawRequest })).toEqual([])
  })

  it('drops an unsigned push', async () => {
    const { rawRequest } = push()
    delete rawRequest.headers['x-radioso-signature']
    expect(await appTester(trigger('routine_completed').perform, { authData, subscribeData, rawRequest })).toEqual([])
  })

  it("drops another type's event on this trigger", async () => {
    const { rawRequest } = push({ type: 'handoff.requested' })
    expect(await appTester(trigger('routine_completed').perform, { authData, subscribeData, rawRequest })).toEqual([])
  })

  it('reads header names in any case', async () => {
    const { event, rawRequest } = push()
    rawRequest.headers = {
      'X-Radioso-Timestamp': rawRequest.headers['x-radioso-timestamp'],
      'X-Radioso-Signature': rawRequest.headers['x-radioso-signature'],
    }
    expect(await appTester(trigger('routine_completed').perform, { authData, subscribeData, rawRequest })).toEqual([event])
  })
})

describe('signature check', () => {
  const now = 1_767_225_600
  const body = '{"id":"e1","type":"routine.completed"}'
  // Computed with the backend's signedWebhook recipe: HMAC-SHA256 over "{timestamp}.{rawBody}".
  const KNOWN_DIGEST = 'ab83d1c69fc6abfedd5e2108a9f3c3e40d812929f2908b881fa6582de35d3f50'
  const request = (timestamp, digest = KNOWN_DIGEST) => ({
    headers: { 'x-radioso-timestamp': String(timestamp), 'x-radioso-signature': `sha256=${digest}` },
    content: body,
  })

  it('accepts the known vector', () => {
    expect(isAuthenticPush({ rawRequest: request(now), secret: SECRET, nowSeconds: now })).toBe(true)
  })

  it('rejects a different digest', () => {
    expect(isAuthenticPush({ rawRequest: request(now, 'a'.repeat(64)), secret: SECRET, nowSeconds: now })).toBe(false)
    expect(isAuthenticPush({ rawRequest: request(now, 'short'), secret: SECRET, nowSeconds: now })).toBe(false)
  })

  it('accepts a timestamp up to five minutes off and rejects more', () => {
    const signed = (timestamp) => ({
      headers: { 'x-radioso-timestamp': String(timestamp), 'x-radioso-signature': sign(SECRET, timestamp, body) },
      content: body,
    })
    expect(isAuthenticPush({ rawRequest: signed(now - 300), secret: SECRET, nowSeconds: now })).toBe(true)
    expect(isAuthenticPush({ rawRequest: signed(now - 301), secret: SECRET, nowSeconds: now })).toBe(false)
    expect(isAuthenticPush({ rawRequest: signed(now + 301), secret: SECRET, nowSeconds: now })).toBe(false)
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

  it('keeps the version and workspace out of the listed output fields', () => {
    for (const key of EVENT_KEYS) {
      const keys = trigger(key).outputFields.map((field) => field.key)
      expect(keys).not.toContain('version')
      expect(keys).not.toContain('workspaceId')
    }
  })
})
