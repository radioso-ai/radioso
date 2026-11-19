import { describe, expect, it, vi } from 'vitest';
import type { IHookFunctions, INode, IPollFunctions, IWebhookFunctions } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import { isRadiosoEvent } from '../nodes/Radioso/events';
import { RadiosoPollTrigger } from '../nodes/RadiosoPollTrigger/RadiosoPollTrigger.node';
import { RadiosoTrigger } from '../nodes/RadiosoTrigger/RadiosoTrigger.node';

const node: INode = {
	id: 'n1',
	name: 'Radioso Trigger',
	type: '@radioso/n8n-nodes-radioso.radiosoTrigger',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

const WEBHOOK_URL = 'https://n8n.example/webhook/abc/webhook';
const CREDENTIALS = { environment: 'custom', customUrl: 'https://radioso.example.com/backend' };

type Reply = { statusCode: number; body: unknown };

function http(replies: Reply[]) {
	const queue = [...replies];
	return vi.fn<(credential: string, options: unknown) => Promise<Reply>>(async () => {
		const next = queue.shift();
		if (!next) throw new Error('unexpected request');
		return next;
	});
}

function hookContext(staticData: Record<string, unknown>, replies: Reply[], events = ['routine.completed']) {
	const request = http(replies);
	const warn = vi.fn();
	const context = {
		getNode: () => node,
		getCredentials: async () => CREDENTIALS,
		getNodeParameter: () => events,
		getNodeWebhookUrl: () => WEBHOOK_URL,
		getWorkflowStaticData: () => staticData,
		logger: { warn },
		helpers: { httpRequestWithAuthentication: request },
	};
	return { context: context as unknown as IHookFunctions, request, warn };
}

const methods = new RadiosoTrigger().webhookMethods.default;

describe('Radioso Trigger lifecycle', () => {
	it('creates a subscription for its webhook URL and keeps the signing secret', async () => {
		const staticData: Record<string, unknown> = {};
		const { context, request } = hookContext(staticData, [
			{ statusCode: 201, body: { subscription: { id: 'sub-1' }, signingSecret: 'whsec_x' } },
		]);

		await methods.create.call(context);

		expect(request).toHaveBeenCalledWith(
			'radiosoApi',
			expect.objectContaining({
				method: 'POST',
				url: 'https://radioso.example.com/backend/api/v1/workspace/event-subscriptions',
				body: { targetUrl: WEBHOOK_URL, eventTypes: ['routine.completed'], label: 'n8n' },
			}),
		);
		expect(staticData.subscription).toEqual({
			subscriptionId: 'sub-1',
			signingSecret: 'whsec_x',
			targetUrl: WEBHOOK_URL,
			eventTypes: ['routine.completed'],
		});
	});

	it('explains a refused target URL as a setup problem', async () => {
		const { context } = hookContext({}, [
			{ statusCode: 400, body: { error: { code: 'invalid_target_url', message: 'not public' } } },
		]);
		const failure = await methods.create.call(context).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(NodeApiError);
		expect((failure as NodeApiError).description).toContain('WEBHOOK_URL');
	});

	it('checkExists reads the stored subscription and clears it when it is gone', async () => {
		const staticData: Record<string, unknown> = {
			subscription: {
				subscriptionId: 'sub-1',
				signingSecret: 'x',
				targetUrl: WEBHOOK_URL,
				eventTypes: ['routine.completed'],
			},
		};
		const { context, request } = hookContext(staticData, [{ statusCode: 404, body: {} }]);

		expect(await methods.checkExists.call(context)).toBe(false);
		expect(request).toHaveBeenCalledWith(
			'radiosoApi',
			expect.objectContaining({
				method: 'GET',
				url: 'https://radioso.example.com/backend/api/v1/workspace/event-subscriptions/sub-1',
			}),
		);
		expect(staticData.subscription).toBeUndefined();
	});

	it('checkExists is true for an active subscription', async () => {
		const staticData = {
			subscription: { subscriptionId: 'sub-1', signingSecret: 'x', targetUrl: WEBHOOK_URL, eventTypes: ['routine.completed'] },
		};
		const { context } = hookContext(staticData, [
			{ statusCode: 200, body: { subscription: { status: 'active' } } },
		]);
		expect(await methods.checkExists.call(context)).toBe(true);
	});

	it('delete unsubscribes, treats 404 as success and forgets the secret', async () => {
		const staticData: Record<string, unknown> = {
			subscription: { subscriptionId: 'sub-1', signingSecret: 'x', targetUrl: WEBHOOK_URL, eventTypes: [] },
		};
		const { context, request } = hookContext(staticData, [{ statusCode: 404, body: {} }]);

		expect(await methods.delete.call(context)).toBe(true);
		expect(request).toHaveBeenCalledWith('radiosoApi', expect.objectContaining({ method: 'DELETE' }));
		expect(staticData.subscription).toBeUndefined();
	});

	it('checkExists never deletes: a copied workflow with another URL just resubscribes', async () => {
		const staticData: Record<string, unknown> = {
			subscription: {
				subscriptionId: 'sub-prod',
				signingSecret: 'x',
				targetUrl: 'https://prod.example/webhook/abc/webhook',
				eventTypes: ['routine.completed'],
			},
		};
		const { context, request } = hookContext(staticData, []);

		expect(await methods.checkExists.call(context)).toBe(false);
		expect(request).not.toHaveBeenCalled();
		expect(staticData.subscription).toBeUndefined();
	});

	it('checkExists keeps a matching subscription through a server error', async () => {
		const staticData = {
			subscription: { subscriptionId: 'sub-1', signingSecret: 'x', targetUrl: WEBHOOK_URL, eventTypes: ['routine.completed'] },
		};
		const { context } = hookContext(staticData, [{ statusCode: 503, body: {} }]);
		expect(await methods.checkExists.call(context)).toBe(true);
		expect(staticData.subscription).toBeDefined();
	});

	it('explains a 404 on the event routes as an instance without the event API', async () => {
		const staticData = {
			subscription: { subscriptionId: 'sub-1', signingSecret: 'x', targetUrl: WEBHOOK_URL, eventTypes: ['routine.completed'] },
		};
		const { context } = hookContext(staticData, [{ statusCode: 400, body: {} }]);
		const failure = await methods.checkExists.call(context).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(NodeApiError);

		const created = hookContext({}, [{ statusCode: 404, body: {} }]);
		const notFound = await methods.create.call(created.context).catch((error: unknown) => error);
		expect((notFound as NodeApiError).message).toBe('This Radioso instance has no event API');
	});

	it('a failed delete is logged and reported as false without throwing', async () => {
		const staticData: Record<string, unknown> = {
			subscription: { subscriptionId: 'sub-1', signingSecret: 'x', targetUrl: WEBHOOK_URL, eventTypes: [] },
		};
		const { context, warn } = hookContext(staticData, [{ statusCode: 500, body: {} }]);

		expect(await methods.delete.call(context)).toBe(false);
		expect(warn).toHaveBeenCalled();
		expect(staticData.subscription).toBeDefined();
	});

	it('requires at least one event', async () => {
		const { context, request } = hookContext({}, [], []);
		await expect(methods.create.call(context)).rejects.toThrow('Choose at least one event');
		expect(request).not.toHaveBeenCalled();
	});
});

const SECRET = 'whsec_test_secret';
const TIMESTAMP = '1763560000';
const ENVELOPE = {
	id: '6f1c2d4e-8a90-4b1c-9d2e-3f4a5b6c7d8e',
	type: 'routine.completed',
	version: 1,
	occurredAt: '2026-11-19T14:02:11.482Z',
	workspaceId: '4d7293c8-d241-4f8f-a4db-3df5b88da44c',
	data: { conversationId: 'c-1', outcome: 'complete', values: { name: 'Ada Example' } },
};

async function sign(rawBody: string, secret: string, timestamp: string): Promise<string> {
	const { createHmac } = await import('crypto');
	return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

function webhookContext(options: { rawBody?: string; headers: Record<string, string | undefined>; withSecret?: boolean }) {
	const status = vi.fn().mockReturnThis();
	const json = vi.fn();
	const rawBody = options.rawBody;
	const context = {
		getRequestObject: () => ({
			rawBody: rawBody === undefined ? undefined : Buffer.from(rawBody, 'utf8'),
			header: (name: string) => options.headers[name.toLowerCase()],
		}),
		getResponseObject: () => ({ status, json }),
		getWorkflowStaticData: () => ({
			subscription:
				options.withSecret === false
					? undefined
					: { subscriptionId: 'sub-1', signingSecret: SECRET, targetUrl: WEBHOOK_URL, eventTypes: [] },
		}),
		getBodyData: () => (rawBody === undefined ? {} : JSON.parse(rawBody)),
		helpers: { returnJsonArray: (value: unknown) => [{ json: value }] },
	};
	return { context: context as unknown as IWebhookFunctions, status, json };
}

describe('Radioso Trigger webhook', () => {
	const now = Number(TIMESTAMP);

	it('emits the envelope as one item when the signature is valid', async () => {
		vi.useFakeTimers({ now: now * 1000 });
		try {
			// Pretty-printed on purpose: the signature covers the bytes as sent, not a re-serialisation.
			const rawBody = JSON.stringify(ENVELOPE, null, 2);
			const { context, status } = webhookContext({
				rawBody,
				headers: {
					'x-radioso-timestamp': TIMESTAMP,
					'x-radioso-signature': await sign(rawBody, SECRET, TIMESTAMP),
				},
			});

			const result = await new RadiosoTrigger().webhook.call(context);

			expect(status).not.toHaveBeenCalled();
			const items = result.workflowData?.[0] ?? [];
			expect(items).toHaveLength(1);
			expect(isRadiosoEvent(items[0].json)).toBe(true);
			expect(items[0].json).toEqual(ENVELOPE);
		} finally {
			vi.useRealTimers();
		}
	});

	it('emits a signed body that is not an event envelope as received', async () => {
		vi.useFakeTimers({ now: now * 1000 });
		try {
			const rawBody = JSON.stringify({ hello: 'world' });
			const { context, status } = webhookContext({
				rawBody,
				headers: {
					'x-radioso-timestamp': TIMESTAMP,
					'x-radioso-signature': await sign(rawBody, SECRET, TIMESTAMP),
				},
			});

			const result = await new RadiosoTrigger().webhook.call(context);

			expect(status).not.toHaveBeenCalled();
			expect(result.workflowData?.[0][0].json).toEqual({ hello: 'world' });
		} finally {
			vi.useRealTimers();
		}
	});

	it('accepts a push exactly 300 seconds old and refuses one second more', async () => {
		const rawBody = JSON.stringify(ENVELOPE);
		const headers = {
			'x-radioso-timestamp': TIMESTAMP,
			'x-radioso-signature': await sign(rawBody, SECRET, TIMESTAMP),
		};
		vi.useFakeTimers({ now: (now + 300) * 1000 });
		try {
			const edge = webhookContext({ rawBody, headers });
			expect((await new RadiosoTrigger().webhook.call(edge.context)).workflowData).toHaveLength(1);
			expect(edge.status).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
		vi.useFakeTimers({ now: (now + 301) * 1000 });
		try {
			const late = webhookContext({ rawBody, headers });
			await new RadiosoTrigger().webhook.call(late.context);
			expect(late.status).toHaveBeenCalledWith(401);
		} finally {
			vi.useRealTimers();
		}
	});

	it('answers 401 and does not trigger on a bad signature', async () => {
		vi.useFakeTimers({ now: now * 1000 });
		try {
			const rawBody = JSON.stringify(ENVELOPE);
			const { context, status } = webhookContext({
				rawBody,
				headers: {
					'x-radioso-timestamp': TIMESTAMP,
					'x-radioso-signature': await sign(rawBody, 'wrong-secret', TIMESTAMP),
				},
			});

			const result = await new RadiosoTrigger().webhook.call(context);

			expect(status).toHaveBeenCalledWith(401);
			expect(result.noWebhookResponse).toBe(true);
			expect(result.workflowData).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('answers 401 for a correctly signed push outside the replay window', async () => {
		vi.useFakeTimers({ now: (now + 301) * 1000 });
		try {
			const rawBody = JSON.stringify(ENVELOPE);
			const { context, status } = webhookContext({
				rawBody,
				headers: {
					'x-radioso-timestamp': TIMESTAMP,
					'x-radioso-signature': await sign(rawBody, SECRET, TIMESTAMP),
				},
			});

			const result = await new RadiosoTrigger().webhook.call(context);

			expect(status).toHaveBeenCalledWith(401);
			expect(result.workflowData).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('answers 401 when the raw body or the stored secret is missing', async () => {
		const noRaw = webhookContext({ headers: {} });
		await new RadiosoTrigger().webhook.call(noRaw.context);
		expect(noRaw.status).toHaveBeenCalledWith(401);

		const noSecret = webhookContext({ rawBody: '{}', headers: {}, withSecret: false });
		await new RadiosoTrigger().webhook.call(noSecret.context);
		expect(noSecret.status).toHaveBeenCalledWith(401);
	});
});

function pollContext(options: { mode: 'manual' | 'trigger'; staticData: Record<string, unknown>; replies: Reply[] }) {
	const request = http(options.replies);
	const context = {
		getNode: () => node,
		getMode: () => options.mode,
		getCredentials: async () => CREDENTIALS,
		getNodeParameter: () => ['routine.completed'],
		getWorkflowStaticData: () => options.staticData,
		helpers: { httpRequestWithAuthentication: request },
	};
	return { context: context as unknown as IPollFunctions, request };
}

const BASE = 'https://radioso.example.com/backend';
const logEvent = (id: string) => ({ ...ENVELOPE, id });

describe('Radioso Poll Trigger', () => {
	it('stores the cursor on the first run and emits nothing', async () => {
		const staticData: Record<string, unknown> = {};
		const { context, request } = pollContext({
			mode: 'trigger',
			staticData,
			replies: [{ statusCode: 200, body: { events: [logEvent('e1')], nextCursor: 'c1', hasMore: false } }],
		});

		expect(await new RadiosoPollTrigger().poll.call(context)).toBeNull();

		expect(request).toHaveBeenCalledWith(
			'radiosoApi',
			expect.objectContaining({
				method: 'GET',
				url: 'https://radioso.example.com/backend/api/v1/workspace/events',
				qs: { types: 'routine.completed', limit: 1 },
			}),
		);
		expect(staticData.cursor).toBe('c1');
	});

	it('emits new events as items and advances the cursor', async () => {
		const staticData: Record<string, unknown> = { cursor: 'c1', types: 'routine.completed', baseUrl: BASE, seen: [] };
		const { context } = pollContext({
			mode: 'trigger',
			staticData,
			replies: [{ statusCode: 200, body: { events: [logEvent('e2'), logEvent('e3')], nextCursor: 'c3', hasMore: false } }],
		});

		const result = await new RadiosoPollTrigger().poll.call(context);

		expect(result?.[0].map((item) => (item.json as { id: string }).id)).toEqual(['e2', 'e3']);
		expect(result?.[0].every((item) => isRadiosoEvent(item.json))).toBe(true);
		expect(staticData.cursor).toBe('c3');
	});

	it.each([
		[410, { error: { code: 'cursor_expired' } }],
		[400, { error: { code: 'invalid_cursor' } }],
		[400, { error: { code: 'cursor_filter_mismatch' } }],
	])('starts over from the end of the log when the cursor is refused (%s)', async (statusCode, body) => {
		const staticData: Record<string, unknown> = { cursor: 'old', types: 'routine.completed', baseUrl: BASE, seen: [] };
		const { context } = pollContext({
			mode: 'trigger',
			staticData,
			replies: [
				{ statusCode, body },
				{ statusCode: 200, body: { events: [logEvent('e9')], nextCursor: 'c9', hasMore: false } },
			],
		});

		expect(await new RadiosoPollTrigger().poll.call(context)).toBeNull();
		expect(staticData.cursor).toBe('c9');
	});

	it('starts over when the credential points at another instance', async () => {
		const staticData: Record<string, unknown> = {
			cursor: 'c1',
			types: 'routine.completed',
			baseUrl: 'https://elsewhere.example',
			seen: [],
		};
		const { context, request } = pollContext({
			mode: 'trigger',
			staticData,
			replies: [{ statusCode: 200, body: { events: [logEvent('e1')], nextCursor: 'c5', hasMore: false } }],
		});

		expect(await new RadiosoPollTrigger().poll.call(context)).toBeNull();
		expect(request).toHaveBeenCalledTimes(1);
		expect(staticData).toMatchObject({ cursor: 'c5', baseUrl: BASE });
	});

	it('refuses a response that is not an event page, with the /backend hint', async () => {
		const html = pollContext({ mode: 'trigger', staticData: { cursor: 'c1', types: 'routine.completed', baseUrl: BASE }, replies: [{ statusCode: 200, body: '<html></html>' }] });
		const htmlFailure = await new RadiosoPollTrigger().poll.call(html.context).catch((error: unknown) => error);
		expect(htmlFailure).toBeInstanceOf(NodeOperationError);

		const odd = pollContext({ mode: 'trigger', staticData: { cursor: 'c1', types: 'routine.completed', baseUrl: BASE }, replies: [{ statusCode: 200, body: { events: 'nope' } }] });
		const oddFailure = await new RadiosoPollTrigger().poll.call(odd.context).catch((error: unknown) => error);
		expect(oddFailure).toBeInstanceOf(NodeOperationError);
		expect((oddFailure as NodeOperationError).description).toContain('/backend');
	});

	it('emits a sample on a manual run without touching the saved cursor', async () => {
		const staticData: Record<string, unknown> = {};
		const { context } = pollContext({
			mode: 'manual',
			staticData,
			replies: [{ statusCode: 200, body: { events: [logEvent('e1')], nextCursor: 'c1', hasMore: false } }],
		});

		const result = await new RadiosoPollTrigger().poll.call(context);

		expect(result?.[0]).toHaveLength(1);
		expect(staticData.cursor).toBeUndefined();
	});

	it('surfaces an API error with the mapped message', async () => {
		const { context } = pollContext({
			mode: 'trigger',
			staticData: { cursor: 'c1', types: 'routine.completed' },
			replies: [{ statusCode: 403, body: { error: { code: 'event_type_not_permitted', message: 'no' } } }],
		});
		const failure = await new RadiosoPollTrigger().poll.call(context).catch((error: unknown) => error);
		expect((failure as NodeApiError).message).toBe('The token cannot read one of the chosen event types');
	});
});

describe('trigger descriptions', () => {
	it('mark both as triggers and neither as an AI tool', () => {
		for (const trigger of [new RadiosoTrigger(), new RadiosoPollTrigger()]) {
			expect(trigger.description.group).toEqual(['trigger']);
			expect(trigger.description.inputs).toEqual([]);
			expect(trigger.description).not.toHaveProperty('usableAsTool');
		}
		expect(new RadiosoPollTrigger().description.polling).toBe(true);
		expect(new RadiosoTrigger().description.webhooks?.[0].httpMethod).toBe('POST');
	});
});
