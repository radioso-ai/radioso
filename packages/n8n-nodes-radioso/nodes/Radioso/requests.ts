import type { INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

export type Resource = 'agent' | 'knowledge' | 'document' | 'conversation';

export interface RadiosoRequest {
	method: 'GET' | 'POST';
	path: string;
	qs?: Record<string, string | number>;
	body?: Record<string, unknown>;
	timeoutMs?: number;
}

/** Reads a node parameter for the current item. */
export type ParameterReader = (name: string, fallback?: unknown) => unknown;

const ASK_TIMEOUT_MS = 120_000;

function text(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function required(node: INode, read: ParameterReader, name: string, label: string): string {
	const value = text(read(name, ''));
	if (value === '') throw new NodeOperationError(node, `${label} is required.`);
	return value;
}

function parseMetadata(node: INode, raw: unknown): Record<string, string | number | boolean | null> | undefined {
	if (raw === undefined || raw === '' || raw === null) return undefined;
	let value: unknown = raw;
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw);
		} catch {
			throw new NodeOperationError(node, 'Metadata must be valid JSON.');
		}
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new NodeOperationError(node, 'Metadata must be a JSON object.');
	}
	for (const [key, entry] of Object.entries(value)) {
		const scalar = entry === null || ['string', 'number', 'boolean'].includes(typeof entry);
		if (!scalar) {
			throw new NodeOperationError(node, 
				`Metadata "${key}" must be a string, number, boolean or null; nested values are not accepted.`,
			);
		}
	}
	return Object.keys(value).length === 0
		? undefined
		: (value as Record<string, string | number | boolean | null>);
}

function optionalFields(read: ParameterReader, names: string[]): Record<string, string> {
	const fields = (read('additionalFields', {}) ?? {}) as Record<string, unknown>;
	const picked: Record<string, string> = {};
	for (const name of names) {
		const value = text(fields[name]);
		if (value !== '') picked[name] = value;
	}
	return picked;
}

/** Maps one operation's parameters to the Radioso API request it makes. */
export function buildRequest(
	node: INode,
	resource: Resource,
	operation: string,
	read: ParameterReader,
): RadiosoRequest {
	switch (`${resource}:${operation}`) {
		case 'agent:ask': {
			const optional = optionalFields(read, ['conversationId', 'userExpectedLocale', 'userTimeZone']);
			// A conversation keeps its agent; naming a different one makes the API answer 404.
			const agent = optional.conversationId
				? {}
				: { agentId: required(node, read, 'agentId', 'Agent (needed to start a conversation)') };
			return {
				method: 'POST',
				path: '/api/v1/assistant/chat',
				timeoutMs: ASK_TIMEOUT_MS,
				body: { ...agent, message: required(node, read, 'message', 'Message'), ...optional },
			};
		}
		case 'knowledge:search': {
			const fields = (read('additionalFields', {}) ?? {}) as Record<string, unknown>;
			const topK = typeof fields.topK === 'number' ? fields.topK : undefined;
			return {
				method: 'POST',
				path: '/api/v1/retrieval/search',
				body: {
					query: required(node, read, 'query', 'Query'),
					...optionalFields(read, ['agentId']),
					...(topK === undefined ? {} : { topK }),
				},
			};
		}
		case 'knowledge:answer':
			return {
				method: 'POST',
				path: '/api/v1/retrieval/answer',
				timeoutMs: ASK_TIMEOUT_MS,
				body: {
					query: required(node, read, 'query', 'Query'),
					...optionalFields(read, ['agentId']),
				},
			};
		case 'document:create': {
			const metadata = parseMetadata(node, read('metadata', ''));
			return {
				method: 'POST',
				path: '/api/v1/document',
				body: {
					title: required(node, read, 'title', 'Title'),
					content: required(node, read, 'content', 'Content'),
					...optionalFields(read, ['externalDocumentId']),
					...(metadata ? { metadata } : {}),
				},
			};
		}
		case 'conversation:get': {
			const conversationId = required(node, read, 'conversationId', 'Conversation ID');
			const fields = (read('additionalFields', {}) ?? {}) as Record<string, unknown>;
			const qs: Record<string, number> = {};
			if (typeof fields.limit === 'number') qs.limit = fields.limit;
			if (typeof fields.offset === 'number') qs.offset = fields.offset;
			return {
				method: 'GET',
				path: `/api/v1/history/chat/${encodeURIComponent(conversationId)}`,
				qs,
			};
		}
		default:
			throw new NodeOperationError(node, `Unknown operation "${operation}" for resource "${resource}".`);
	}
}

/** What the node outputs for a successful response. */
export function shapeResponse(
	resource: Resource,
	operation: string,
	body: unknown,
): Record<string, unknown> {
	const json = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
	if (resource === 'document' && operation === 'create') {
		return {
			...json,
			processing: 'asynchronous',
			note: 'The document was accepted. Radioso chunks and embeds it in the background; it is searchable once its status is ready.',
		};
	}
	if (resource === 'agent' && operation === 'ask') {
		const ownership = json.ownership as { state?: string } | undefined;
		// With a teammate in the conversation, `answer` is the waiting message shown to the visitor
		// and `assistantMessageId` is empty: the agent did not answer.
		return { ...json, humanOwned: ownership?.state === 'human_owned' };
	}
	return json;
}
