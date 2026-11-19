import nock from 'nock'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import zapier from 'zapier-platform-core'

import App from '../index.js'

const appTester = zapier.createAppTester(App)
const ORIGIN = 'https://api.example'
const TOKEN = 'radioso_svc_v1_example'
const authData = { instance_url: ORIGIN, api_token: TOKEN }
const AGENT_ID = '0f6b3a52-7c1e-4d0e-9a4b-3d2f6a1c8e10'
const CONVERSATION_ID = '9c0a1b6e-5a43-4c61-a1f8-2d7e0c7f3b10'

const radioso = () =>
  nock(ORIGIN, { reqheaders: { authorization: `Bearer ${TOKEN}` } })

beforeAll(() => {
  nock.disableNetConnect()
})

afterEach(() => {
  expect(nock.pendingMocks()).toEqual([])
  nock.cleanAll()
})

describe('authentication', () => {
  it('tests the credential against the workspace summary', async () => {
    radioso().get('/api/v1/workspace/summary').reply(200, { documentCount: 3, readyDocumentCount: 3, pendingDocumentCount: 0, sampleDocumentCount: 0 })
    const result = await appTester(App.authentication.test, { authData })
    expect(result.documentCount).toBe(3)
  })

  it('accepts an instance URL with a trailing slash or a pasted /api/v1', async () => {
    radioso().get('/api/v1/workspace/summary').reply(200, { documentCount: 0 })
    await appTester(App.authentication.test, { authData: { ...authData, instance_url: `${ORIGIN}/api/v1/` } })
  })

  it('rejects a token the instance does not accept as an expired connection', async () => {
    radioso().get('/api/v1/workspace/summary').reply(401, { error: { code: 'unauthorized', message: 'Invalid credential' } })
    await expect(appTester(App.authentication.test, { authData })).rejects.toThrow(/Invalid credential/)
  })

  it('rejects an instance URL that is not a URL before sending anything', async () => {
    await expect(
      appTester(App.authentication.test, { authData: { ...authData, instance_url: 'radioso' } }),
    ).rejects.toThrow(/Instance URL must start with https/)
  })

  it('labels the connection with the workspace name, else the instance host', async () => {
    const label = (inputData) => appTester(App.authentication.connectionLabel, { inputData })
    expect(await label({ instance_url: ORIGIN, workspace_name: 'Support' })).toBe('Support')
    expect(await label({ instance_url: `${ORIGIN}/` })).toBe('api.example')
  })
})

describe('agent dropdown', () => {
  it('lists agents as id and name', async () => {
    radioso().get('/api/v1/agents').reply(200, { agents: [{ id: AGENT_ID, name: 'Support agent', internalName: 'support', workspaceId: 'w', createdAt: 'x', updatedAt: 'x' }] })
    const agents = await appTester(App.triggers.agent.operation.perform, { authData })
    expect(agents).toEqual([{ id: AGENT_ID, name: 'Support agent' }])
  })
})

describe('Ask an Agent', () => {
  const chatReply = {
    conversationId: CONVERSATION_ID,
    assistantMessageId: '5d1c2c3e-0b4a-4e0a-8f7a-6a5f0f1b2c31',
    agentId: AGENT_ID,
    agentName: 'Support agent',
    answer: 'You can return an item within 30 days.',
    citations: [{ documentId: 'd', chunkId: 'c', title: 'Returns policy', sourceUrl: 'https://docs.example/returns' }],
    ownership: { state: 'ai_owned', suppressed: false },
  }

  it('starts a conversation with the chosen agent and returns the answer', async () => {
    radioso()
      .post('/api/v1/assistant/chat', { message: 'Can I return this?', agentId: AGENT_ID })
      .reply(200, chatReply)
    const result = await appTester(App.creates.ask_agent.operation.perform, {
      authData,
      inputData: { message: 'Can I return this?', agent_id: AGENT_ID },
    })
    expect(result).toMatchObject({
      conversation_id: CONVERSATION_ID,
      answer: 'You can return an item within 30 days.',
      citations: [{ title: 'Returns policy', url: 'https://docs.example/returns' }],
      conversation_owner: 'ai_owned',
    })
  })

  it('continues an existing conversation and leaves the agent to the conversation', async () => {
    radioso()
      .post('/api/v1/assistant/chat', { message: 'And for sale items?', conversationId: CONVERSATION_ID })
      .reply(200, chatReply)
    await appTester(App.creates.ask_agent.operation.perform, {
      authData,
      inputData: { message: 'And for sale items?', conversation_id: CONVERSATION_ID },
    })
  })

  it('reports an agent that is not published with the API message', async () => {
    radioso()
      .post('/api/v1/assistant/chat')
      .reply(404, { error: { code: 'agent_not_published', message: 'This agent has not been published.' } })
    await expect(
      appTester(App.creates.ask_agent.operation.perform, { authData, inputData: { message: 'Hi', agent_id: AGENT_ID } }),
    ).rejects.toThrow(/not been published/)
  })
})

describe('Search Knowledge', () => {
  it('returns the best match first with the full result list', async () => {
    radioso()
      .post('/api/v1/retrieval/search', { query: 'returns', topK: 2 })
      .reply(200, {
        outcome: 'results',
        results: [
          { documentId: 'd1', chunkId: 'c1', title: 'Returns policy', content: '30 days.', score: 0.82, dateFrom: null, dateTo: null },
          { documentId: 'd2', chunkId: 'c2', title: 'Shipping', content: 'Free over 50.', score: 0.4, dateFrom: null, dateTo: null },
        ],
      })
    const result = await appTester(App.creates.search_knowledge.operation.perform, {
      authData,
      inputData: { query: 'returns', top_k: '2' },
    })
    expect(result).toMatchObject({ result_count: 2, top_title: 'Returns policy', top_content: '30 days.' })
    expect(result.results[1]).toMatchObject({ chunk_id: 'c2', score: 0.4 })
  })

  it('returns an empty result instead of failing when nothing matches', async () => {
    radioso().post('/api/v1/retrieval/search', { query: 'unknown' }).reply(200, { outcome: 'results', results: [] })
    const result = await appTester(App.creates.search_knowledge.operation.perform, { authData, inputData: { query: 'unknown' } })
    expect(result).toMatchObject({ result_count: 0, top_title: null, results: [] })
  })
})

describe('Add a Document', () => {
  it('queues the document and returns its id and processing status', async () => {
    radioso()
      .post('/api/v1/document', { title: 'Refund FAQ', content: 'Refunds take 5 days.', externalDocumentId: 'crm-42' })
      .reply(202, { documentId: '3b9f2c1a-6d4e-4a8b-8c21-5e7d9a0b1c34', status: 'pending' })
    const result = await appTester(App.creates.add_document.operation.perform, {
      authData,
      inputData: { title: 'Refund FAQ', content: 'Refunds take 5 days.', external_document_id: 'crm-42' },
    })
    expect(result).toMatchObject({ document_id: '3b9f2c1a-6d4e-4a8b-8c21-5e7d9a0b1c34', status: 'pending' })
  })

  it('surfaces a validation error from the API', async () => {
    radioso().post('/api/v1/document').reply(400, { error: { code: 'validation_failed', message: 'content must not be empty' } })
    await expect(
      appTester(App.creates.add_document.operation.perform, { authData, inputData: { title: 'T', content: ' ' } }),
    ).rejects.toThrow(/content must not be empty/)
  })
})

describe('Find Conversation', () => {
  it('returns the conversation with a transcript and no visitor or request details', async () => {
    radioso()
      .get(`/api/v1/history/chat/${CONVERSATION_ID}`)
      .query({ limit: 100 })
      .reply(200, {
        conversationId: CONVERSATION_ID,
        agentId: AGENT_ID,
        agentName: 'Support agent',
        sourceChannel: 'website_embed',
        title: 'Return window question',
        createdAt: '2026-11-19T09:12:00.000Z',
        updatedAt: '2026-11-19T09:13:10.000Z',
        messageCount: 2,
        hasOlderMessages: false,
        requestContext: { ip: '203.0.113.9' },
        visitor: { email: 'visitor@example.test' },
        messages: [
          { id: 'm1', role: 'user', content: 'How long do I have?' },
          { id: 'm2', role: 'assistant', content: '30 days.' },
        ],
        ownership: { state: 'human_owned' },
      })
    const [conversation] = await appTester(App.searches.find_conversation.operation.perform, {
      authData,
      inputData: { conversation_id: CONVERSATION_ID },
    })
    expect(conversation).toMatchObject({
      id: CONVERSATION_ID,
      conversation_owner: 'human_owned',
      transcript: 'user: How long do I have?\nassistant: 30 days.',
      transcript_is_partial: false,
    })
    expect(JSON.stringify(conversation)).not.toMatch(/203\.0\.113\.9|visitor@example/)
  })

  it('finds nothing for an unknown conversation so the Zap can branch', async () => {
    radioso()
      .get(`/api/v1/history/chat/${CONVERSATION_ID}`)
      .query(true)
      .reply(404, { error: { code: 'not_found', message: 'Conversation not found' } })
    const found = await appTester(App.searches.find_conversation.operation.perform, {
      authData,
      inputData: { conversation_id: CONVERSATION_ID },
    })
    expect(found).toEqual([])
  })
})
