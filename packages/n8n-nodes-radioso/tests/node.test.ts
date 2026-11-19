import { describe, expect, it, vi } from 'vitest';
import type { IExecuteFunctions, ILoadOptionsFunctions, INode } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import { Radioso } from '../nodes/Radioso/Radioso.node';

const node: INode = {
	id: 'n1',
	name: 'Radioso',
	type: '@radioso/n8n-nodes-radioso.radioso',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

interface Reply {
	statusCode: number;
	body: unknown;
}

function context(
	parameters: Record<string, unknown>,
	reply: Reply | Error,
	options: { continueOnFail?: boolean; items?: number } = {},
) {
	const httpRequestWithAuthentication = vi.fn(async () => {
		if (reply instanceof Error) throw reply;
		return reply;
	});
	const fakeContext = {
		getNode: () => node,
		getInputData: () => Array.from({ length: options.items ?? 1 }, () => ({ json: {} })),
		getNodeParameter: (name: string, _index: number, fallback?: unknown) =>
			name in parameters ? parameters[name] : fallback,
		getCredentials: async () => ({
			environment: 'custom',
			customUrl: 'https://radioso.example.com/backend/',
		}),
		continueOnFail: () => options.continueOnFail ?? false,
		helpers: { httpRequestWithAuthentication },
	};
	return { fakeContext: fakeContext as unknown as IExecuteFunctions, httpRequestWithAuthentication };
}

const AGENT_ID = '3f2a9a52-7a6e-4a9e-8d57-5b7f0a0c1111';

describe('Radioso node', () => {
	it('is usable as an AI agent tool', () => {
		expect(new Radioso().description.usableAsTool).toBe(true);
	});

	it('asks an agent through the configured instance with the credential applied', async () => {
		const { fakeContext, httpRequestWithAuthentication } = context(
			{ resource: 'agent', operation: 'ask', agentId: AGENT_ID, message: 'Hello' },
			{ statusCode: 200, body: { conversationId: 'c-1', assistantMessageId: 'm-1', answer: 'Hi!' } },
		);

		const [output] = await new Radioso().execute.call(fakeContext);

		expect(httpRequestWithAuthentication).toHaveBeenCalledWith(
			'radiosoApi',
			expect.objectContaining({
				method: 'POST',
				url: 'https://radioso.example.com/backend/api/v1/assistant/chat',
				body: { agentId: AGENT_ID, message: 'Hello' },
			}),
		);
		expect(output[0].json).toMatchObject({ conversationId: 'c-1', answer: 'Hi!' });
		expect(output[0].pairedItem).toEqual({ item: 0 });
	});

	it('turns a rate limit into a clear n8n error', async () => {
		const { fakeContext } = context(
			{ resource: 'knowledge', operation: 'search', query: 'x' },
			{
				statusCode: 429,
				body: { code: 'rate_limit_exceeded', message: 'Slow down', retryAfterSeconds: 30 },
			},
		);

		const failure = await new Radioso().execute.call(fakeContext).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(NodeApiError);
		expect((failure as NodeApiError).message).toBe('Radioso is rate limiting this token');
		expect((failure as NodeApiError).description).toContain('30 seconds');
	});

	it('reports a bad input as an operation error without calling the API', async () => {
		const { fakeContext, httpRequestWithAuthentication } = context(
			{ resource: 'document', operation: 'create', title: 'T', content: 'C', metadata: '{bad' },
			{ statusCode: 202, body: {} },
		);

		const failure = await new Radioso().execute.call(fakeContext).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(NodeOperationError);
		expect(httpRequestWithAuthentication).not.toHaveBeenCalled();
	});

	it('reports an unreachable instance', async () => {
		const { fakeContext } = context(
			{ resource: 'conversation', operation: 'get', conversationId: 'c-1' },
			new Error('getaddrinfo ENOTFOUND radioso.example.com'),
		);

		const failure = await new Radioso().execute.call(fakeContext).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(NodeApiError);
		expect((failure as NodeApiError).message).toBe('Could not reach Radioso');
	});

	it('keeps going per item when Continue On Fail is on', async () => {
		const { fakeContext } = context(
			{ resource: 'conversation', operation: 'get', conversationId: 'c-1' },
			{ statusCode: 404, body: { error: { code: 'not_found', message: 'Conversation not found' } } },
			{ continueOnFail: true, items: 2 },
		);

		const [output] = await new Radioso().execute.call(fakeContext);

		expect(output).toHaveLength(2);
		expect(output[1].json.error).toBe('Radioso could not find it');
	});

	it('loads the agents dropdown from the agents list', async () => {
		const { fakeContext } = context(
			{},
			{
				statusCode: 200,
				body: { agents: [{ id: AGENT_ID, name: 'Support', internalName: 'support' }] },
			},
		);

		const options = await new Radioso().methods.loadOptions.getAgents.call(
			fakeContext as unknown as ILoadOptionsFunctions,
		);

		expect(options).toEqual([{ name: 'Support', value: AGENT_ID }]);
	});
});
