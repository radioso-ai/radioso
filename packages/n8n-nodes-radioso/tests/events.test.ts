import { describe, expect, it, vi } from 'vitest';

import {
	checkSignature,
	createSubscription,
	deleteSubscription,
	isRadiosoEvent,
	pollEvents,
	subscriptionExists,
	type EventsPage,
	type FetchPage,
	type PollState,
	type Send,
	type StoredSubscription,
} from '../nodes/Radioso/events';

// Computed with the recipe of backend verifyWebhookSignature (signedWebhook.ts):
// HMAC-SHA256(secret, `${timestamp}.${rawBody}`) as hex, sent as `sha256=<hex>`.
const SECRET = 'whsec_test_secret';
const TIMESTAMP = '1763560000';
const RAW_BODY = '{"id":"6f1c2d4e-8a90-4b1c-9d2e-3f4a5b6c7d8e","type":"routine.completed"}';
const SIGNATURE = 'sha256=33a65adb812fd0361356633ee8e5e8cf75f35122f13c773aca3148f248187dda';
const NOW = Number(TIMESTAMP);

const signed = {
	rawBody: RAW_BODY,
	secret: SECRET,
	timestamp: TIMESTAMP,
	signatureHeader: SIGNATURE,
	nowSeconds: NOW,
};

describe('push signature', () => {
	it('accepts the known vector', () => {
		expect(checkSignature(signed)).toBe('valid');
	});

	it('rejects a body that changed by one byte, a wrong secret and a malformed header', () => {
		expect(checkSignature({ ...signed, rawBody: `${RAW_BODY} ` })).toBe('bad_signature');
		expect(checkSignature({ ...signed, secret: 'other' })).toBe('bad_signature');
		expect(checkSignature({ ...signed, signatureHeader: SIGNATURE.slice(7) })).toBe('bad_signature');
		expect(checkSignature({ ...signed, signatureHeader: undefined })).toBe('bad_signature');
		expect(checkSignature({ ...signed, timestamp: undefined })).toBe('bad_signature');
		expect(checkSignature({ ...signed, secret: '' })).toBe('bad_signature');
	});

	it('signs the timestamp too, so a replayed body under a new timestamp fails', () => {
		expect(checkSignature({ ...signed, timestamp: String(NOW + 1) })).toBe('bad_signature');
	});

	it('accepts a timestamp up to five minutes off and refuses one beyond', () => {
		expect(checkSignature({ ...signed, nowSeconds: NOW + 300 })).toBe('valid');
		expect(checkSignature({ ...signed, nowSeconds: NOW - 300 })).toBe('valid');
		expect(checkSignature({ ...signed, nowSeconds: NOW + 301 })).toBe('stale_timestamp');
		expect(checkSignature({ ...signed, nowSeconds: NOW - 301 })).toBe('stale_timestamp');
	});
});

const stored: StoredSubscription = {
	subscriptionId: 'sub-1',
	signingSecret: 'secret',
	targetUrl: 'https://n8n.example/webhook/abc/webhook',
	eventTypes: ['routine.completed'],
};
const wanted = { targetUrl: stored.targetUrl, eventTypes: ['routine.completed'] };

describe('subscription lifecycle', () => {
	it('subscribes with the webhook URL, the chosen types and the n8n label', async () => {
		const send = vi.fn<Send>(async () => ({
			statusCode: 201,
			body: { subscription: { id: 'sub-1' }, signingSecret: 'secret' },
		}));

		const result = await createSubscription(send, wanted);

		expect(send).toHaveBeenCalledWith({
			method: 'POST',
			path: '/api/v1/workspace/event-subscriptions',
			body: { targetUrl: stored.targetUrl, eventTypes: ['routine.completed'], label: 'n8n' },
		});
		expect(result.stored).toEqual(stored);
	});

	it('reports a refused subscription instead of storing anything', async () => {
		const send: Send = async () => ({ statusCode: 409, body: { error: { code: 'event_subscription_limit_reached' } } });
		const result = await createSubscription(send, wanted);
		expect(result.stored).toBeUndefined();
		expect(result.failure?.statusCode).toBe(409);
	});

	it('finds an active subscription', async () => {
		const send = vi.fn<Send>(async () => ({ statusCode: 200, body: { subscription: { status: 'active' } } }));
		expect(await subscriptionExists(send, stored, wanted)).toEqual({ exists: true });
		expect(send).toHaveBeenCalledWith({ method: 'GET', path: '/api/v1/workspace/event-subscriptions/sub-1' });
	});

	it('treats a 404 or a disabled subscription as gone', async () => {
		const missing: Send = async () => ({ statusCode: 404, body: { error: { code: 'not_found' } } });
		const disabled: Send = async () => ({ statusCode: 200, body: { subscription: { status: 'disabled' } } });
		expect((await subscriptionExists(missing, stored, wanted)).exists).toBe(false);
		expect((await subscriptionExists(disabled, stored, wanted)).exists).toBe(false);
	});

	it('does not resubscribe on a refusal, it surfaces it', async () => {
		const send: Send = async () => ({ statusCode: 403, body: {} });
		const result = await subscriptionExists(send, stored, wanted);
		expect(result.failure?.statusCode).toBe(403);
	});

	it('has nothing to check without stored data', async () => {
		const send = vi.fn<Send>();
		expect((await subscriptionExists(send, undefined, wanted)).exists).toBe(false);
		expect(send).not.toHaveBeenCalled();
	});

	it('treats a subscription made for another URL or types as gone without deleting anything', async () => {
		const send = vi.fn<Send>();
		const otherTypes = await subscriptionExists(send, stored, { ...wanted, eventTypes: ['handoff.requested'] });
		const otherUrl = await subscriptionExists(send, stored, { ...wanted, targetUrl: 'https://other.example/hook' });
		expect(otherTypes.exists).toBe(false);
		expect(otherUrl.exists).toBe(false);
		expect(send).not.toHaveBeenCalled();
	});

	it('keeps a matching subscription through a transient failure', async () => {
		for (const statusCode of [429, 500, 503]) {
			const result = await subscriptionExists(async () => ({ statusCode, body: {} }), stored, wanted);
			expect(result).toEqual({ exists: true });
		}
	});

	it('deletes, and treats 404 as success', async () => {
		const send = vi.fn<Send>(async () => ({ statusCode: 204, body: undefined }));
		expect(await deleteSubscription(send, stored)).toBeUndefined();
		expect(send).toHaveBeenCalledWith({ method: 'DELETE', path: '/api/v1/workspace/event-subscriptions/sub-1' });
		expect(await deleteSubscription(async () => ({ statusCode: 404, body: {} }), stored)).toBeUndefined();
		expect((await deleteSubscription(async () => ({ statusCode: 500, body: {} }), stored))?.statusCode).toBe(500);
	});
});

function event(id: string, type = 'routine.completed') {
	return {
		id,
		type,
		version: 1,
		occurredAt: '2026-11-19T14:02:11.482Z',
		workspaceId: 'ws-1',
		data: { conversationId: 'c-1' },
	};
}

function pages(...results: Array<{ page?: EventsPage; expired?: boolean }>) {
	const queries: Array<Record<string, string | number>> = [];
	const queue = [...results];
	const fetchPage: FetchPage = async (query) => {
		queries.push(query);
		const next = queue.shift();
		if (!next) throw new Error('unexpected request');
		return next;
	};
	return { fetchPage, queries };
}

const TYPES = ['routine.completed', 'handoff.requested'];
const KEY = 'handoff.requested,routine.completed';
const BASE = 'https://radioso.example.com/backend';

describe('polling', () => {
	it('stores the end of the log on the first run and emits nothing', async () => {
		const { fetchPage, queries } = pages({ page: { events: [event('e1')], nextCursor: 'c1', hasMore: false } });

		const result = await pollEvents(fetchPage, {}, { types: TYPES, manual: false, baseUrl: BASE });

		expect(result.events).toEqual([]);
		expect(result.state).toMatchObject({ cursor: 'c1', types: KEY });
		expect(queries[0]).toEqual({ types: KEY, limit: 1 });
	});

	it('emits the newest few as a sample in manual mode and leaves the state alone', async () => {
		const { fetchPage, queries } = pages({
			page: { events: [event('e1'), event('e2')], nextCursor: 'c9', hasMore: false },
		});
		const state: PollState = {};

		const result = await pollEvents(fetchPage, state, { types: TYPES, manual: true, baseUrl: BASE });

		expect(result.events.map((e) => e.id)).toEqual(['e1', 'e2']);
		expect(result.state).toBe(state);
		expect(queries[0]).toEqual({ types: KEY, limit: 3 });
	});

	it('moves the cursor forward and emits only what is new, oldest first', async () => {
		const { fetchPage, queries } = pages({
			page: { events: [event('e2'), event('e3')], nextCursor: 'c2', hasMore: false },
		});

		const result = await pollEvents(fetchPage, { cursor: 'c1', types: KEY, baseUrl: BASE, seen: ['e1'] }, { types: TYPES, manual: false, baseUrl: BASE });

		expect(queries[0]).toMatchObject({ after: 'c1', types: KEY });
		expect(result.events.map((e) => e.id)).toEqual(['e2', 'e3']);
		expect(result.state.cursor).toBe('c2');
	});

	it('keeps the cursor of an empty page, which moves on its own', async () => {
		const { fetchPage } = pages({ page: { events: [], nextCursor: 'c5', hasMore: false } });
		const result = await pollEvents(fetchPage, { cursor: 'c1', types: KEY, baseUrl: BASE, seen: [] }, { types: TYPES, manual: false, baseUrl: BASE });
		expect(result.events).toEqual([]);
		expect(result.state.cursor).toBe('c5');
	});

	it('reads further pages while more are waiting', async () => {
		const { fetchPage, queries } = pages(
			{ page: { events: [event('e2')], nextCursor: 'c2', hasMore: true } },
			{ page: { events: [event('e3')], nextCursor: 'c3', hasMore: false } },
		);

		const result = await pollEvents(fetchPage, { cursor: 'c1', types: KEY, baseUrl: BASE, seen: [] }, { types: TYPES, manual: false, baseUrl: BASE });

		expect(queries[1]).toMatchObject({ after: 'c2' });
		expect(result.events.map((e) => e.id)).toEqual(['e2', 'e3']);
		expect(result.state.cursor).toBe('c3');
	});

	it('starts over like a first run when the cursor is expired', async () => {
		const { fetchPage, queries } = pages(
			{ expired: true },
			{ page: { events: [event('e7')], nextCursor: 'c7', hasMore: false } },
		);

		const result = await pollEvents(fetchPage, { cursor: 'old', types: KEY, baseUrl: BASE, seen: [] }, { types: TYPES, manual: false, baseUrl: BASE });

		expect(queries[0]).toMatchObject({ after: 'old' });
		expect(queries[1]).toEqual({ types: KEY, limit: 1 });
		expect(result.events).toEqual([]);
		expect(result.state.cursor).toBe('c7');
	});

	it('starts over when the credential points at another instance', async () => {
		const { fetchPage, queries } = pages({ page: { events: [], nextCursor: 'c9', hasMore: false } });
		const result = await pollEvents(
			fetchPage,
			{ cursor: 'c1', types: KEY, baseUrl: 'https://other.example', seen: ['x'] },
			{ types: TYPES, manual: false, baseUrl: BASE },
		);
		expect(queries).toHaveLength(1);
		expect(queries[0]).not.toHaveProperty('after');
		expect(result.state).toMatchObject({ cursor: 'c9', baseUrl: BASE, seen: [] });
	});

	it('stops after ten pages and keeps the cursor of the last one while more are waiting', async () => {
		const results = Array.from({ length: 10 }, (_, index) => ({
			page: { events: [event(`p${index}`)], nextCursor: `c${index + 2}`, hasMore: true },
		}));
		const { fetchPage, queries } = pages(...results);

		const result = await pollEvents(fetchPage, { cursor: 'c1', types: KEY, baseUrl: BASE, seen: [] }, { types: TYPES, manual: false, baseUrl: BASE });

		expect(queries).toHaveLength(10);
		expect(result.events).toHaveLength(10);
		expect(result.state.cursor).toBe('c11');
	});

	it('keeps only the newest 500 ids', async () => {
		const seen = Array.from({ length: 500 }, (_, index) => `old${index}`);
		const { fetchPage } = pages({ page: { events: [event('fresh')], nextCursor: 'c2', hasMore: false } });

		const result = await pollEvents(fetchPage, { cursor: 'c1', types: KEY, baseUrl: BASE, seen }, { types: TYPES, manual: false, baseUrl: BASE });

		expect(result.state.seen).toHaveLength(500);
		expect(result.state.seen?.[0]).toBe('old1');
		expect(result.state.seen?.[499]).toBe('fresh');
	});

	it('does not emit an id it has already emitted, across runs', async () => {
		const first = pages({ page: { events: [event('e2')], nextCursor: 'c2', hasMore: false } });
		const run1 = await pollEvents(first.fetchPage, { cursor: 'c1', types: KEY, baseUrl: BASE, seen: [] }, { types: TYPES, manual: false, baseUrl: BASE });
		const second = pages({ page: { events: [event('e2'), event('e3')], nextCursor: 'c3', hasMore: false } });
		const run2 = await pollEvents(second.fetchPage, run1.state, { types: TYPES, manual: false, baseUrl: BASE });

		expect(run1.events.map((e) => e.id)).toEqual(['e2']);
		expect(run2.events.map((e) => e.id)).toEqual(['e3']);
	});

	it('starts over from the end of the log when the chosen types change', async () => {
		const { fetchPage } = pages({ page: { events: [event('e1')], nextCursor: 'c9', hasMore: false } });
		const result = await pollEvents(fetchPage, { cursor: 'c1', types: 'other', baseUrl: BASE, seen: ['x'] }, { types: TYPES, manual: false, baseUrl: BASE });
		expect(result.events).toEqual([]);
		expect(result.state).toMatchObject({ cursor: 'c9', types: KEY, baseUrl: BASE, seen: [] });
	});

	it('emits only envelopes that match the contract', async () => {
		const { fetchPage } = pages({
			page: { events: [event('e2'), { id: 'bad' }, null], nextCursor: 'c2', hasMore: false },
		});
		const result = await pollEvents(fetchPage, { cursor: 'c1', types: KEY, baseUrl: BASE, seen: [] }, { types: TYPES, manual: false, baseUrl: BASE });
		expect(result.events).toHaveLength(1);
		expect(result.events.every(isRadiosoEvent)).toBe(true);
	});
});
