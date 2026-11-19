import { radiosoRequest } from './client.js'
import { isAuthenticPush } from './signature.js'

const SUBSCRIPTIONS = '/workspace/event-subscriptions'

const dataField = (key, label, extra = {}) => ({ key: `data__${key}`, label, ...extra })

/** What every event names: the conversation it belongs to. `data` carries these ahead of what the type adds. */
const conversationFields = [
  dataField('conversationId', 'Conversation ID'),
  dataField('agentId', 'Agent ID'),
  dataField('channel', 'Channel'),
  dataField('callerKind', 'Caller kind'),
  dataField('visitorId', 'Visitor ID'),
]

const envelopeFields = [
  { key: 'id', label: 'Event ID' },
  { key: 'type', label: 'Event type' },
  { key: 'occurredAt', label: 'Occurred at', type: 'datetime' },
]

/** Zapier shows the newest sample first; the list API serves a page in log order. */
const newestFirst = (events) => [...events].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))

/**
 * Builds one REST hook trigger for one event type. Subscribing registers Zapier's target URL with
 * Radioso; every push is verified against the subscription's own signing secret before it reaches
 * the Zap, so a request that did not come from Radioso starts nothing.
 */
export const eventTrigger = ({ key, type, noun, label, description, sample, detailFields }) => {
  const subscribe = async (z, bundle) => {
    const body = await radiosoRequest(z, bundle, {
      method: 'POST',
      path: SUBSCRIPTIONS,
      body: { targetUrl: bundle.targetUrl, eventTypes: [type], label: 'zapier' },
    })
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

  // Zapier ignores a hook whose perform returns an empty array, so an unverified request starts no Zap.
  const perform = async (z, bundle) => {
    const secret = bundle.subscribeData && bundle.subscribeData.signingSecret
    if (!isAuthenticPush({ rawRequest: bundle.rawRequest, secret })) return []
    let event
    try {
      event = JSON.parse(bundle.rawRequest.content)
    } catch {
      return []
    }
    if (!event || typeof event.id !== 'string' || event.type !== type) return []
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
      outputFields: [...envelopeFields, ...conversationFields, ...detailFields],
    },
  }
}

const sampleSubject = {
  conversationId: '9c0a1b6e-5a43-4c61-a1f8-2d7e0c7f3b10',
  agentId: '0f6b3a52-7c1e-4d0e-9a4b-3d2f6a1c8e10',
  channel: 'web',
  callerKind: 'human',
  visitorId: '5b1d7c2e-3f4a-4e8b-9c6d-1a2b3c4d5e6f',
}

export const sampleEvent = (type, data) => ({
  id: '4e7a2d90-6b1c-4f35-8a0e-7d3c9b2f1a64',
  type,
  version: 1,
  occurredAt: '2026-01-15T10:30:00.000Z',
  workspaceId: '7a1f0c34-2b6d-4e58-9f13-0c8d5e6a7b92',
  data: { ...sampleSubject, ...data },
})
