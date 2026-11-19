import { createHmac, timingSafeEqual } from 'crypto';

export const EVENT_TYPES = [
	{ name: 'Contact Request Created', value: 'contact_request.created' },
	{ name: 'Conversation Started', value: 'conversation.started' },
	{ name: 'Decision Pending', value: 'decision.pending' },
	{ name: 'Handoff Requested', value: 'handoff.requested' },
	{ name: 'Routine Completed', value: 'routine.completed' },
] as const;

const KNOWN_TYPES: ReadonlySet<string> = new Set(EVENT_TYPES.map((type) => type.value));

/** The envelope every Radioso event carries, in the event log and in a push. */
export interface RadiosoEvent {
	id: string;
	type: string;
	version: number;
	occurredAt: string;
	workspaceId: string;
	data: Record<string, unknown>;
}

export function isRadiosoEvent(value: unknown): value is RadiosoEvent {
	if (typeof value !== 'object' || value === null) return false;
	const event = value as Record<string, unknown>;
	return (
		typeof event.id === 'string' &&
		event.id !== '' &&
		typeof event.type === 'string' &&
		typeof event.version === 'number' &&
		typeof event.occurredAt === 'string' &&
		typeof event.workspaceId === 'string' &&
		typeof event.data === 'object' &&
		event.data !== null &&
		!Array.isArray(event.data)
	);
}

/** The event types the user picked, or an empty list if the parameter holds anything else. */
export function selectedEventTypes(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return [...new Set(raw.filter((value): value is string => typeof value === 'string' && KNOWN_TYPES.has(value)))];
}

// ---- Push signature -------------------------------------------------------------------------

export const REPLAY_WINDOW_SECONDS = 5 * 60;

export type SignatureCheck = 'valid' | 'bad_signature' | 'stale_timestamp';

/**
 * Checks a push from Radioso: `X-Radioso-Signature` is `sha256=<hex HMAC-SHA256(secret,
 * "{timestamp}.{rawBody}")>`, where `rawBody` is the request body byte for byte as it arrived.
 * A timestamp more than five minutes from now is refused so a captured push cannot be replayed.
 */
export function checkSignature(input: {
	rawBody: string;
	secret: string;
	timestamp: string | undefined;
	signatureHeader: string | undefined;
	nowSeconds: number;
}): SignatureCheck {
	const { rawBody, secret, timestamp, signatureHeader, nowSeconds } = input;
	const signature = signatureHeader?.startsWith('sha256=') ? signatureHeader.slice('sha256='.length) : '';
	if (secret === '' || timestamp === undefined || !/^\d{1,12}$/u.test(timestamp)) return 'bad_signature';
	if (!/^[a-f0-9]{64}$/iu.test(signature)) return 'bad_signature';
	const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
	const actual = Buffer.from(signature, 'hex');
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return 'bad_signature';
	return Math.abs(nowSeconds - Number(timestamp)) > REPLAY_WINDOW_SECONDS ? 'stale_timestamp' : 'valid';
}

// ---- Subscription lifecycle -----------------------------------------------------------------

export interface HttpResult {
	statusCode: number;
	body: unknown;
}

export type Send = (request: {
	method: 'GET' | 'POST' | 'DELETE';
	path: string;
	body?: Record<string, unknown>;
}) => Promise<HttpResult>;

/** What the webhook node remembers about its subscription, in the workflow's static data. */
export interface StoredSubscription {
	subscriptionId: string;
	signingSecret: string;
	targetUrl: string;
	eventTypes: string[];
}

const SUBSCRIPTIONS_PATH = '/api/v1/workspace/event-subscriptions';

function sameTypes(a: string[], b: string[]): boolean {
	return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

export function readStored(raw: unknown): StoredSubscription | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined;
	const stored = raw as Record<string, unknown>;
	if (typeof stored.subscriptionId !== 'string' || typeof stored.signingSecret !== 'string') return undefined;
	return {
		subscriptionId: stored.subscriptionId,
		signingSecret: stored.signingSecret,
		targetUrl: typeof stored.targetUrl === 'string' ? stored.targetUrl : '',
		eventTypes: Array.isArray(stored.eventTypes) ? (stored.eventTypes as string[]) : [],
	};
}

/**
 * True while the stored subscription is still active for this URL and these types. A 404, a
 * disabled subscription, or one made for another URL or type list counts as gone, so n8n creates a
 * fresh one. Any other answer is an error, not a reason to subscribe again.
 */
export async function subscriptionExists(
	send: Send,
	stored: StoredSubscription | undefined,
	wanted: { targetUrl: string; eventTypes: string[] },
): Promise<{ exists: boolean; failure?: HttpResult }> {
	if (!stored) return { exists: false };
	if (stored.targetUrl !== wanted.targetUrl || !sameTypes(stored.eventTypes, wanted.eventTypes)) {
		// Drop the old one so it stops pushing to a URL this node no longer listens on.
		await send({ method: 'DELETE', path: `${SUBSCRIPTIONS_PATH}/${encodeURIComponent(stored.subscriptionId)}` });
		return { exists: false };
	}
	const response = await send({
		method: 'GET',
		path: `${SUBSCRIPTIONS_PATH}/${encodeURIComponent(stored.subscriptionId)}`,
	});
	if (response.statusCode === 404) return { exists: false };
	if (response.statusCode < 200 || response.statusCode >= 300) return { exists: false, failure: response };
	const subscription = (response.body as { subscription?: { status?: string } } | null)?.subscription;
	return { exists: subscription?.status === 'active' };
}

/** Subscribes. The signing secret comes back only on this response, so the caller stores it. */
export async function createSubscription(
	send: Send,
	wanted: { targetUrl: string; eventTypes: string[] },
): Promise<{ stored?: StoredSubscription; failure?: HttpResult }> {
	const response = await send({
		method: 'POST',
		path: SUBSCRIPTIONS_PATH,
		body: { targetUrl: wanted.targetUrl, eventTypes: wanted.eventTypes, label: 'n8n' },
	});
	if (response.statusCode !== 201) return { failure: response };
	const body = response.body as { subscription?: { id?: unknown }; signingSecret?: unknown } | null;
	if (typeof body?.subscription?.id !== 'string' || typeof body.signingSecret !== 'string') {
		return { failure: response };
	}
	return {
		stored: {
			subscriptionId: body.subscription.id,
			signingSecret: body.signingSecret,
			targetUrl: wanted.targetUrl,
			eventTypes: wanted.eventTypes,
		},
	};
}

/** Unsubscribes. A subscription that is already gone counts as deleted. */
export async function deleteSubscription(send: Send, stored: StoredSubscription): Promise<HttpResult | undefined> {
	const response = await send({
		method: 'DELETE',
		path: `${SUBSCRIPTIONS_PATH}/${encodeURIComponent(stored.subscriptionId)}`,
	});
	const gone = response.statusCode === 404 || (response.statusCode >= 200 && response.statusCode < 300);
	return gone ? undefined : response;
}

// ---- Polling --------------------------------------------------------------------------------

export interface PollState {
	cursor?: string;
	/** The event types the cursor was issued for; a cursor only works with the filter it came from. */
	types?: string;
	/** Recent event ids, newest last, so a page read twice emits once. */
	seen?: string[];
}

export interface EventsPage {
	events: unknown[];
	nextCursor: string | null;
	hasMore: boolean;
}

export type FetchPage = (query: Record<string, string | number>) => Promise<{ page?: EventsPage; expired?: boolean }>;

const SAMPLE_SIZE = 3;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_POLL = 10;
const SEEN_LIMIT = 500;

function validEvents(events: unknown[]): RadiosoEvent[] {
	return events.filter(isRadiosoEvent);
}

/**
 * One poll of the event log. The first run stores the log's end and emits nothing, so a workflow
 * does not wake up to old events; a manual run emits the newest few as sample data and stores
 * nothing. After that each run emits what happened since the stored cursor, oldest first. A
 * `410 cursor_expired` starts again without a cursor. Returns the events to emit and the state to
 * keep.
 */
export async function pollEvents(
	fetchPage: FetchPage,
	state: PollState,
	options: { types: string[]; manual: boolean },
): Promise<{ events: RadiosoEvent[]; state: PollState }> {
	const typesKey = [...options.types].sort().join(',');
	const base = { types: typesKey };

	if (options.manual) {
		const sample = await fetchPage({ ...base, limit: SAMPLE_SIZE });
		return { events: validEvents(sample.page?.events ?? []), state };
	}

	let cursor = state.types === typesKey ? state.cursor : undefined;
	if (cursor === undefined) {
		const head = await fetchPage({ ...base, limit: 1 });
		return { events: [], state: { cursor: head.page?.nextCursor ?? undefined, types: typesKey, seen: [] } };
	}

	const seen = new Set(state.seen ?? []);
	const emitted: RadiosoEvent[] = [];
	for (let pageNumber = 0; pageNumber < MAX_PAGES_PER_POLL; pageNumber++) {
		let result = await fetchPage({ ...base, limit: PAGE_SIZE, ...(cursor ? { after: cursor } : {}) });
		if (result.expired) {
			cursor = undefined;
			result = await fetchPage({ ...base, limit: PAGE_SIZE });
		}
		const page = result.page;
		if (!page) break;
		for (const event of validEvents(page.events)) {
			if (seen.has(event.id)) continue;
			seen.add(event.id);
			emitted.push(event);
		}
		if (page.nextCursor) cursor = page.nextCursor;
		if (!page.hasMore) break;
	}
	return {
		events: emitted,
		state: { cursor, types: typesKey, seen: [...seen].slice(-SEEN_LIMIT) },
	};
}
