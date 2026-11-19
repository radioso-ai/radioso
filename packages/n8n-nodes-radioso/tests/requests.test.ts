import { describe, expect, it } from 'vitest';
import type { INode } from 'n8n-workflow';

import { buildRequest, shapeResponse, type ParameterReader } from '../nodes/Radioso/requests';

const node: INode = {
	id: 'n1',
	name: 'Radioso',
	type: '@radioso/n8n-nodes-radioso.radioso',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

const reader =
	(values: Record<string, unknown>): ParameterReader =>
	(name, fallback) =>
		name in values ? values[name] : fallback;

const AGENT_ID = '3f2a9a52-7a6e-4a9e-8d57-5b7f0a0c1111';

describe('Ask an agent', () => {
	it('posts the message to the assistant chat route for the chosen agent', () => {
		const request = buildRequest(
			node,
			'agent',
			'ask',
			reader({ agentId: AGENT_ID, message: ' Where is my order? ' }),
		);
		expect(request.method).toBe('POST');
		expect(request.path).toBe('/api/v1/assistant/chat');
		expect(request.body).toEqual({ agentId: AGENT_ID, message: 'Where is my order?' });
	});

	it('continues a conversation and passes locale and time zone when given', () => {
		const request = buildRequest(
			node,
			'agent',
			'ask',
			reader({
				agentId: AGENT_ID,
				message: 'And tomorrow?',
				additionalFields: {
					conversationId: 'c-1',
					userExpectedLocale: 'de-DE',
					userTimeZone: 'Europe/Berlin',
					ignored: 'x',
				},
			}),
		);
		expect(request.body).toEqual({
			agentId: AGENT_ID,
			message: 'And tomorrow?',
			conversationId: 'c-1',
			userExpectedLocale: 'de-DE',
			userTimeZone: 'Europe/Berlin',
		});
	});

	it('leaves out an empty conversation id so a new conversation starts', () => {
		const request = buildRequest(
			node,
			'agent',
			'ask',
			reader({ agentId: AGENT_ID, message: 'Hi', additionalFields: { conversationId: '  ' } }),
		);
		expect(request.body).not.toHaveProperty('conversationId');
	});

	it('refuses to send without an agent or a message', () => {
		expect(() => buildRequest(node, 'agent', 'ask', reader({ message: 'Hi' }))).toThrow(
			'Agent is required.',
		);
		expect(() => buildRequest(node, 'agent', 'ask', reader({ agentId: AGENT_ID }))).toThrow(
			'Message is required.',
		);
	});
});

describe('Knowledge', () => {
	it('searches with an optional agent scope and result count', () => {
		const request = buildRequest(
			node,
			'knowledge',
			'search',
			reader({ query: 'refund policy', additionalFields: { agentId: AGENT_ID, topK: 5 } }),
		);
		expect(request).toMatchObject({
			method: 'POST',
			path: '/api/v1/retrieval/search',
			body: { query: 'refund policy', agentId: AGENT_ID, topK: 5 },
		});
	});

	it('searches the whole workspace when no agent is chosen', () => {
		const request = buildRequest(node, 'knowledge', 'search', reader({ query: 'refund policy' }));
		expect(request.body).toEqual({ query: 'refund policy' });
	});

	it('requests a grounded answer through the retrieval answer route', () => {
		const request = buildRequest(
			node,
			'knowledge',
			'answer',
			reader({ query: 'How long is shipping?', additionalFields: { agentId: AGENT_ID, topK: 5 } }),
		);
		expect(request.path).toBe('/api/v1/retrieval/answer');
		expect(request.body).toEqual({ query: 'How long is shipping?', agentId: AGENT_ID });
	});
});

describe('Add a document', () => {
	it('creates a text document with metadata and an external id', () => {
		const request = buildRequest(
			node,
			'document',
			'create',
			reader({
				title: 'Returns',
				content: '30 days.',
				metadata: '{"category":"policy","version":2,"draft":false,"owner":null}',
				additionalFields: { externalDocumentId: 'cms-77' },
			}),
		);
		expect(request).toMatchObject({
			method: 'POST',
			path: '/api/v1/document',
			body: {
				title: 'Returns',
				content: '30 days.',
				externalDocumentId: 'cms-77',
				metadata: { category: 'policy', version: 2, draft: false, owner: null },
			},
		});
	});

	it('accepts metadata that n8n already parsed into an object', () => {
		const request = buildRequest(
			node,
			'document',
			'create',
			reader({ title: 'T', content: 'C', metadata: { a: 'b' } }),
		);
		expect(request.body).toMatchObject({ metadata: { a: 'b' } });
	});

	it.each([
		['not json', 'Metadata must be valid JSON.'],
		['[1]', 'Metadata must be a JSON object.'],
		['{"a":{"b":1}}', 'nested values are not accepted'],
	])('rejects metadata %s before calling the API', (metadata, message) => {
		expect(() =>
			buildRequest(node, 'document', 'create', reader({ title: 'T', content: 'C', metadata })),
		).toThrow(message);
	});

	it('says processing is asynchronous in the output', () => {
		const output = shapeResponse('document', 'create', {
			documentId: 'd-1',
			status: 'processing',
		});
		expect(output).toMatchObject({ documentId: 'd-1', status: 'processing', processing: 'asynchronous' });
		expect(String(output.note)).toContain('background');
	});
});

describe('Get a conversation', () => {
	it('reads the transcript by id with a message window', () => {
		const request = buildRequest(
			node,
			'conversation',
			'get',
			reader({ conversationId: 'c 1/2', additionalFields: { limit: 20, offset: 40 } }),
		);
		expect(request).toEqual({
			method: 'GET',
			path: '/api/v1/history/chat/c%201%2F2',
			qs: { limit: 20, offset: 40 },
		});
	});

	it('passes the response through unchanged', () => {
		const body = { conversationId: 'c-1', messages: [] };
		expect(shapeResponse('conversation', 'get', body)).toEqual(body);
	});
});

it('rejects an unknown operation', () => {
	expect(() => buildRequest(node, 'agent', 'nope', reader({}))).toThrow('Unknown operation');
});
