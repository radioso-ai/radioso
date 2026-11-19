import { radiosoRequest } from './client.js'
import { pushRejection } from './signature.js'

const SUBSCRIPTIONS = '/workspace/event-subscriptions'

/** Longer than Radioso's 24 hour retry horizon, so a retried event is still recognised. */
const DEDUPE_TTL_SECONDS = 2 * 24 * 60 * 60

const dataField = (key, label, extra = {}) => ({ key: `data__${key}`, label, ...extra })

/**
 * What an event names, ahead of what its type adds in `data`: a conversation event the conversation
 * it belongs to, a document event the document revision it happened to.
 */
const subjectFields = {
  conversation: [
    dataField('conversationId', 'Conversation ID'),
    dataField('agentId', 'Agent ID'),
    dataField('channel', 'Channel'),
    dataField('callerKind', 'Caller kind'),
    dataField('visitorId', 'Visitor ID'),
  ],
  document: [
    dataField('documentId', 'Document ID'),
    dataField('revision', 'Revision', { type: 'integer' }),
    dataField('title', 'Title'),
    dataField('sourceKind', 'Source kind'),
    dataField('sourceId', 'Source ID'),
  ],
}

const envelopeFields = [
  { key: 'id', label: 'Event ID' },
  { key: 'type', label: 'Event type' },
  { key: 'occurredAt', label: 'Occurred at', type: 'datetime' },
]

/** Zapier shows the newest sample first; the list API serves a page in log order. */
const newestFirst = (events) => [...events].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))

const drop = (z, reason) => {
  z.console.log(`radioso push dropped: ${reason}`)
  return []
}

/**
 * Radioso delivers at least once and Zapier does not dedupe hook events, so the first sight of an
 * event id claims it in Zapier's cache (set if absent) and a retry finds the claim. When the cache
 * is unavailable the event is delivered: a repeat is better than a lost event.
 */
const alreadyDelivered = async (z, key) => {
  try {
    const claimed = await z.cache.set(key, true, DEDUPE_TTL_SECONDS, null, true)
    return claimed === false || claimed === null
  } catch {
    return false
  }
}

/**
 * Builds one REST hook trigger for one event type. Subscribing registers Zapier's target URL with
 * Radioso; every push is verified against the subscription's own signing secret before it reaches
 * the Zap, so a request that did not come from Radioso starts nothing.
 */
export const eventTrigger = ({ key, type, noun, label, description, sample, detailFields, subject = 'conversation' }) => {
  const subscribe = async (z, bundle) => {
    const body = await radiosoRequest(z, bundle, {
      method: 'POST',
      path: SUBSCRIPTIONS,
      body: { targetUrl: bundle.targetUrl, eventTypes: [type], label: 'zapier' },
      allowNotFound: true,
    })
    // A 404 on the collection route means the instance predates the subscriptions API.
    if (body === null) {
      throw new z.errors.Error('This Radioso instance does not support event triggers yet.', 'events_unsupported', 404)
    }
    // Zapier keeps this as bundle.subscribeData. The secret is returned only here.
    return { id: body.subscription.id, signingSecret: body.signingSecret }
  }

  const unsubscribe = async (z, bundle) => {
    const id = bundle.subscribeData && bundle.subscribeData.id
    if (id) {
      await radiosoRequest(z, bundle, {
        method: 'DELETE',
        path: `${SUBSCRIPTIONS}/${encodeURIComponent(id)}`,
        allowNotFound: true,
        allowEmptyBody: true,
      })
    }
    return {}
  }

  // Zapier ignores a hook whose perform returns an empty array, so a rejected push starts no Zap.
  const perform = async (z, bundle) => {
    const secret = bundle.subscribeData && bundle.subscribeData.signingSecret
    const rejection = pushRejection({ rawRequest: bundle.rawRequest, secret })
    if (rejection) return drop(z, rejection)
    let event
    try {
      event = JSON.parse(bundle.rawRequest.content)
    } catch {
      return drop(z, 'bad_json')
    }
    if (!event || typeof event.id !== 'string' || event.type !== type) return drop(z, 'type_mismatch')
    if (await alreadyDelivered(z, `${bundle.subscribeData.id}:${event.id}`)) return drop(z, 'duplicate')
    return [event]
  }

  const performList = async (z, bundle) => {
    const body = await radiosoRequest(z, bundle, { path: '/workspace/events', params: { types: type, limit: 3 } })
    return newestFirst(body.events || [])
  }

  return {
    key,
    noun,
    display: { label, description },
    operation: {
      type: 'hook',
      performSubscribe: subscribe,
      performUnsubscribe: unsubscribe,
      perform,
      performList,
      sample,
      outputFields: [...envelopeFields, ...subjectFields[subject], ...detailFields],
    },
  }
}

const sampleSubjects = {
  conversation: {
    conversationId: '9c0a1b6e-5a43-4c61-a1f8-2d7e0c7f3b10',
    agentId: '0f6b3a52-7c1e-4d0e-9a4b-3d2f6a1c8e10',
    channel: 'website_embed',
    callerKind: 'human',
    visitorId: '5b1d7c2e-3f4a-4e8b-9c6d-1a2b3c4d5e6f',
  },
  document: {
    documentId: '2c8e4f1a-9b3d-4a6e-8f2c-7d1b5e9a3c40',
    revision: 2,
    title: 'Opening hours',
    sourceKind: 'inline_text',
    sourceId: '6d4b2a8e-1c7f-4e3a-9b5d-0f8c2e6a4d17',
  },
}

/** A sample event of `type`, its `data` naming a conversation, or a document when `subject` says so. */
export const sampleEvent = (type, data, subject = 'conversation') => ({
  id: '4e7a2d90-6b1c-4f35-8a0e-7d3c9b2f1a64',
  type,
  version: 1,
  occurredAt: '2026-01-15T10:30:00.000Z',
  workspaceId: '7a1f0c34-2b6d-4e58-9f13-0c8d5e6a7b92',
  data: { ...sampleSubjects[subject], ...data },
})
