import { radiosoRequest } from '../lib/client.js'
import { agentField } from '../lib/fields.js'

const searchKnowledge = async (z, bundle) => {
  const input = bundle.inputData
  const request = { query: input.query }
  if (input.agent_id) request.agentId = input.agent_id
  if (input.top_k) request.topK = Number(input.top_k)

  const body = await radiosoRequest(z, bundle, { method: 'POST', path: '/retrieval/search', body: request })
  const results = (body.results || []).map((result) => ({
    document_id: result.documentId,
    chunk_id: result.chunkId,
    title: result.title,
    content: result.content,
    score: result.score,
  }))
  const top = results[0]
  return {
    id: top ? top.chunk_id : 'no-results',
    result_count: results.length,
    top_title: top ? top.title : null,
    top_content: top ? top.content : null,
    results,
  }
}

export default {
  key: 'search_knowledge',
  noun: 'Knowledge result',
  display: {
    label: 'Search Knowledge',
    description: 'Finds the passages in the workspace documents that best match a question, without agent behavior.',
  },
  operation: {
    inputFields: [
      { key: 'query', label: 'Query', required: true, helpText: 'A question or phrase. Up to 4,000 characters.' },
      agentField({
        required: false,
        helpText: "Limits the search to the documents this agent can use. Leave empty to search the whole workspace.",
      }),
      {
        key: 'top_k',
        label: 'Maximum results',
        type: 'integer',
        required: false,
        helpText: 'Between 1 and 100. Leave empty for the workspace default.',
      },
    ],
    perform: searchKnowledge,
    sample: {
      id: '7a4e0d6c-1b52-4c8f-93a7-0e5d1c2b4f66',
      result_count: 1,
      top_title: 'Returns policy',
      top_content: 'Items can be returned within 30 days of delivery.',
      results: [
        {
          document_id: '3b9f2c1a-6d4e-4a8b-8c21-5e7d9a0b1c34',
          chunk_id: '7a4e0d6c-1b52-4c8f-93a7-0e5d1c2b4f66',
          title: 'Returns policy',
          content: 'Items can be returned within 30 days of delivery.',
          score: 0.82,
        },
      ],
    },
    outputFields: [
      { key: 'result_count', label: 'Result count', type: 'integer' },
      { key: 'top_title', label: 'Best match title' },
      { key: 'top_content', label: 'Best match content' },
    ],
  },
}
