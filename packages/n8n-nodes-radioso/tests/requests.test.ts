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
			message: 'And tomorrow?',
			conversationId: 'c-1',
			userExpectedLocale: 'de-DE',
			userTimeZone: 'Europe/Berlin',
		});
	});

	it('omits the agent when continuing a conversation, which keeps its own agent', () => {
		const request = buildRequest(
			node,
			'agent',
			'ask',
			reader({
				agentId: AGENT_ID,
				message: 'And tomorrow?',
				additionalFields: { conversationId: 'c-1' },
			}),
		);
		expect(request.body).toEqual({ message: 'And tomorrow?', conversationId: 'c-1' });
	});

	it('needs no agent when continuing a conversation', () => {
		expect(() =>
			buildRequest(
				node,
				'agent',
				'ask',
				reader({ message: 'Hi', additionalFields: { conversationId: 'c-1' } }),
			),
		).not.toThrow();
	});

	it('flags a suppressed reply, where the answer is the waiting message and no agent answered', () => {
		const output = shapeResponse('agent', 'ask', {
			conversationId: 'c-1',
			assistantMessageId: '',
			answer: 'A teammate will answer shortly.',
			ownership: { state: 'human_owned', suppressed: true },
		});
		expect(output).toMatchObject({
			conversationOwner: 'human_owned',
			replySuppressed: true,
			assistantMessageId: '',
		});
	});

	it('does not flag the handoff turn, which is teammate-owned but carries a real answer', () => {
		const output = shapeResponse('agent', 'ask', {
			assistantMessageId: 'm-1',
			answer: 'I am passing you to a teammate.',
			ownership: { state: 'human_owned', suppressed: false },
		});
		expect(output).toMatchObject({ conversationOwner: 'human_owned', replySuppressed: false });
	});

	it('reports an agent-owned reply as such', () => {
		expect(shapeResponse('agent', 'ask', { answer: 'Hi', ownership: { state: 'ai_owned', suppressed: false } }))
			.toMatchObject({ conversationOwner: 'ai_owned', replySuppressed: false });
		expect(shapeResponse('agent', 'ask', { answer: 'Hi' })).toMatchObject({
			conversationOwner: 'ai_owned',
			replySuppressed: false,
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

	it('starts a conversation with the workspace default agent when none is chosen', () => {
		const request = buildRequest(node, 'agent', 'ask', reader({ message: 'Hi' }));
		expect(request.body).toEqual({ message: 'Hi' });
	});

	it('refuses to send without a message', () => {
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
			status: 'pending',
		});
		expect(output).toMatchObject({ documentId: 'd-1', status: 'pending', processing: 'asynchronous' });
		expect(String(output.note)).toContain('background');
	});

	it('reports unchanged content, which comes back ready at once, as complete', () => {
		const output = shapeResponse('document', 'create', { documentId: 'd-1', status: 'ready' });
		expect(output).toMatchObject({ status: 'ready', processing: 'complete' });
		expect(String(output.note)).toContain('ready and searchable now');
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

	it('reads the newest 100 messages when no window is given', () => {
		const request = buildRequest(node, 'conversation', 'get', reader({ conversationId: 'c-1' }));
		expect(request.qs).toEqual({ limit: 100 });
	});

	const history = {
		conversationId: 'c-1',
		workspaceId: 'w-1',
		agentId: 'a-1',
		agentName: 'Support',
		agentInternalName: 'support-internal',
		sourceChannel: 'website_embed',
		callerKind: 'visitor',
		sourceOrigin: 'https://shop.example',
		entryPageUrl: 'https://shop.example/cart?email=ada@example.test',
		entryReferrer: 'https://search.example',
		visitor: { name: 'Ada Example', email: 'ada@example.test' },
		requestContext: { ip: '203.0.113.7', country: 'GB', userAgent: 'Mozilla/5.0' },
		channelContext: { kind: 'web', pageUrl: 'https://shop.example/cart' },
		title: 'Return window',
		createdAt: '2026-11-19T09:12:00.000Z',
		updatedAt: '2026-11-19T09:13:10.000Z',
		messageCount: 4,
		hasOlderMessages: true,
		ownership: { state: 'human_owned' },
		messages: [
			{ id: 'm0', role: 'system', source: 'system', content: 'internal note', createdAt: 't0' },
			{ id: 'm1', role: 'user', source: 'customer', content: 'Can I return it?', createdAt: 't1' },
			{
				id: 'm2',
				role: 'assistant',
				source: 'human_agent',
				content: 'Yes, within 30 days.',
				createdAt: 't2',
				operatorDisplayName: 'Grace Teammate',
				operatorLabel: 'grace@example.test',
				debug: { model: 'x', prompt: 'secret prompt' },
			},
		],
	};

	it('returns the transcript without the visitor profile, request context or debug data', () => {
		const output = shapeResponse('conversation', 'get', history);
		const serialized = JSON.stringify(output);

		expect(output).toMatchObject({
			conversationId: 'c-1',
			agentName: 'Support',
			sourceChannel: 'website_embed',
			title: 'Return window',
			messageCount: 4,
			conversationOwner: 'human_owned',
			transcriptIsPartial: true,
			transcript: 'customer: Can I return it?\nhuman_agent: Yes, within 30 days.',
		});
		expect(output.messages).toEqual([
			{ source: 'customer', content: 'Can I return it?', createdAt: 't1' },
			{ source: 'human_agent', content: 'Yes, within 30 days.', createdAt: 't2' },
		]);
		for (const key of ['requestContext', 'visitor', 'entryPageUrl', 'entryReferrer', 'channelContext']) {
			expect(output).not.toHaveProperty(key);
		}
		for (const leaked of ['203.0.113.7', 'ada@example.test', 'Grace Teammate', 'secret prompt', 'w-1']) {
			expect(serialized).not.toContain(leaked);
		}
	});

	it('defaults to an agent-owned, complete transcript', () => {
		const output = shapeResponse('conversation', 'get', { conversationId: 'c-1', messages: [] });
		expect(output).toMatchObject({ conversationOwner: 'ai_owned', transcriptIsPartial: false, transcript: '' });
	});
});

it('rejects an unknown operation', () => {
	expect(() => buildRequest(node, 'agent', 'nope', reader({}))).toThrow('Unknown operation');
});
