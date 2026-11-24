import { describe, expect, it } from 'vitest'

import {
  buildApiRequestConfig,
  buildApiTestInput,
  createApiRequestDraft,
  emptyApiFixedParam,
  emptyApiInput,
  emptyApiOutput,
  withOutputFromValue,
  type ApiRequestDraft,
} from '@/components/dashboard/settings/skills/api-request-skill-model'
import {
  inferValueType,
  listOutputFor,
  suggestOutputName,
} from '@/components/dashboard/settings/skills/api-response-tree'
import { buildAgentSkillInput, createInitialSkillDraft } from '@/components/dashboard/settings/skills/skill-form-model'
import type { SkillCapabilityDescriptor } from '@/lib/api-skills'

const savedConfig = {
  method: 'GET',
  path: '/orders/{order_number}',
  boundParams: { currency: 'EUR', limit: 5, '3d': '123' },
  exposedParams: {
    order_number: { type: 'text', description: 'Order number', required: true, verifiedOnly: false },
    email: { type: 'email', slotBinding: 'customer_email', required: false, verifiedOnly: true },
  },
  outputs: {
    status: { path: 'order.status', type: 'text', description: 'Order status', required: true },
    items: {
      path: 'order.items',
      type: 'list',
      required: false,
      maxItems: 5,
      fields: {
        title: { path: 'name', type: 'text', role: 'title' },
        price: { path: 'price', type: 'number' },
      },
    },
  },
}

describe('API request skill config', () => {
  it('reads a saved config into a draft and builds the same config back', () => {
    expect(buildApiRequestConfig(createApiRequestDraft(savedConfig))).toEqual(savedConfig)
  })

  it('keeps a fixed value that reads as another JSON type a string only when it was saved quoted', () => {
    const draft = createApiRequestDraft(savedConfig)
    expect(draft.fixedParams.find((param) => param.key === '3d')?.value).toBe('"123"')
    const edited: ApiRequestDraft = {
      ...draft,
      fixedParams: [
        { ...emptyApiFixedParam(), key: 'limit', value: '10' },
        { ...emptyApiFixedParam(), key: 'flags', value: '{"a":true}' },
        { ...emptyApiFixedParam(), key: 'note', value: 'plain text' },
      ],
    }
    expect(buildApiRequestConfig(edited).boundParams).toEqual({ limit: 10, flags: { a: true }, note: 'plain text' })
  })

  it('drops empty descriptions and slot bindings and clamps a list size', () => {
    const draft = createApiRequestDraft()
    draft.path = '/ping'
    draft.inputs = [{ ...emptyApiInput(), key: 'q', description: '  ', slotBinding: '' }]
    draft.outputs = [{ ...emptyApiOutput('list'), name: 'rows', path: 'rows', maxItems: 99 }]
    const config = buildApiRequestConfig(draft)
    expect(config.exposedParams).toEqual({ q: { type: 'text', required: true, verifiedOnly: false } })
    expect(config.outputs).toEqual({ rows: { path: 'rows', type: 'list', required: false, maxItems: 20, fields: {} } })
  })

  it('refuses a draft that names nothing or names twice', () => {
    const draft = createApiRequestDraft(savedConfig)
    expect(() => buildApiRequestConfig({ ...draft, path: ' ' })).toThrow(/path/u)
    expect(() => buildApiRequestConfig({ ...draft, inputs: [...draft.inputs, { ...emptyApiInput(), key: 'email' }] })).toThrow(/twice/u)
    expect(() => buildApiRequestConfig({ ...draft, outputs: [...draft.outputs, { ...emptyApiOutput(), name: '', path: 'x' }] })).toThrow(/name/u)
    expect(() => buildApiRequestConfig({ ...draft, outputs: [...draft.outputs, { ...emptyApiOutput(), name: 'x', path: '' }] })).toThrow(/path/u)
  })

  it('builds the test request with only the sample values that were filled', () => {
    const draft = createApiRequestDraft(savedConfig)
    const [orderNumber] = draft.inputs
    const input = buildApiTestInput(draft, { [orderNumber.id]: 'A-1' })
    expect(input.exposedSampleValues).toEqual({ order_number: 'A-1' })
    expect(input.method).toBe('GET')
    expect(input.outputs).toEqual(savedConfig.outputs)
  })

  it('is what the skill form submits for an api_request capability', () => {
    const capability = {
      id: 'api_request', storedKind: 'api_request', targetKind: 'api_connection', requiresTarget: true,
      inputSchema: { source: 'static', schema: { fields: [], required: [] } }, settingsFields: [],
      outcomeVocabulary: ['completed'], supportedInvocationModes: ['routine_named'], defaultInvocationMode: 'routine_named',
      executorAdapter: 'api_request', targets: [{ id: 'conn-1', label: 'shop-api' }], available: true, unavailableReason: null,
    } as SkillCapabilityDescriptor
    const draft = createInitialSkillDraft([capability])
    draft.apiRequest = createApiRequestDraft(savedConfig)
    const input = buildAgentSkillInput(capability, draft, [])
    expect(input).toMatchObject({
      capability: 'api_request',
      target: { kind: 'api_connection', id: 'conn-1' },
      invocationMode: 'routine_named',
      config: savedConfig,
    })
  })
})

describe('outputs picked from a response', () => {
  it('infers a declared type from a sample value', () => {
    expect(inferValueType('shipped')).toBe('text')
    expect(inferValueType('a@b.example')).toBe('email')
    expect(inferValueType('2026-11-21')).toBe('date')
    expect(inferValueType('2026-11-21T10:00:00Z')).toBe('date')
    expect(inferValueType(4.5)).toBe('number')
    expect(inferValueType(false)).toBe('boolean')
    expect(inferValueType(null)).toBeNull()
    expect(inferValueType({})).toBeNull()
  })

  it('names an output from the last named key, made safe and unique', () => {
    expect(suggestOutputName(['order', 'shippingStatus'], new Set())).toBe('shipping_status')
    expect(suggestOutputName(['items', 0], new Set())).toBe('items')
    expect(suggestOutputName(['order', 'status'], new Set(['status']))).toBe('status_2')
    expect(suggestOutputName(['9lives'], new Set())).toBe('field_9lives')
    expect(suggestOutputName([], new Set())).toBe('value')
  })

  it('adds a scalar with its dot path and inferred type, once', () => {
    const body = { order: { status: 'shipped', items: [{ name: 'Mug', price: 4.5, sku: 'a.b', photo: 'https://x.example/m.png' }] } }
    const once = withOutputFromValue([], ['order', 'status'], body.order.status)
    expect(once).toHaveLength(1)
    expect(buildApiRequestConfig({ ...createApiRequestDraft(), path: '/o', outputs: once }).outputs).toEqual({
      status: { path: 'order.status', type: 'text', required: false },
    })
    expect(withOutputFromValue(once, ['order', 'status'], 'shipped')).toHaveLength(1)
  })

  it('adds a list with one field per scalar key of the first record', () => {
    const items = [{ name: 'Mug', price: 4.5, 'odd.key': 1, nested: { a: 1 } }]
    expect(listOutputFor(['order', 'items'], items)).toEqual({
      path: 'order.items',
      type: 'list',
      required: false,
      maxItems: 10,
      fields: {
        name: { path: 'name', type: 'text' },
        price: { path: 'price', type: 'number' },
      },
    })
    expect(withOutputFromValue([], ['order', 'items'], items)).toHaveLength(1)
    expect(withOutputFromValue([], ['order', 'items'], [1, 2])).toHaveLength(0)
  })
})
