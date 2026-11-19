import { describe, expect, it } from 'vitest';

import { describeApiError } from '../nodes/Radioso/errors';

describe('API error mapping', () => {
	it('tells the user to check the token on 401', () => {
		const described = describeApiError(401, { error: { code: 'unauthorized', message: 'nope' } });
		expect(described.message).toBe('Radioso rejected the credential');
		expect(described.description).toContain('radioso_svc_v1_');
	});

	it('carries the server explanation on 403', () => {
		const described = describeApiError(403, {
			error: { code: 'forbidden', message: 'Caller lacks workspace.documents.manage' },
		});
		expect(described.message).toBe('The token is not allowed to do this');
		expect(described.description).toContain('workspace.documents.manage');
	});

	it('names the retry delay on 429', () => {
		const described = describeApiError(429, {
			code: 'rate_limit_exceeded',
			message: 'Too many requests',
			retryAfterSeconds: 17,
		});
		expect(described.description).toContain('17 seconds');
	});

	it('explains a missing agent or conversation on 404', () => {
		expect(describeApiError(404, { error: { code: 'not_found', message: 'Conversation not found' } }))
			.toMatchObject({ message: 'Radioso could not find it' });
	});

	it('reads a JSON body that arrives as a string', () => {
		const described = describeApiError(400, '{"error":{"code":"x","message":"query too long"}}');
		expect(described.description).toContain('query too long');
	});

	it('treats a 5xx as a server error even with an empty body', () => {
		expect(describeApiError(503, undefined).message).toBe('Radioso reported a server error');
	});
});
