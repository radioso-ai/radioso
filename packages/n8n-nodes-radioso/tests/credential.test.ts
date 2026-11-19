import { Tournament } from '@n8n/tournament';
import { describe, expect, it } from 'vitest';

import { BASE_URL_EXPRESSION, RadiosoApi } from '../credentials/RadiosoApi.credentials';
import { resolveBaseUrl, type RadiosoCredentials } from '../nodes/Radioso/instance';

/** Evaluates the credential test's base URL the way n8n's expression engine does. */
function evaluateBaseUrl(credentials: RadiosoCredentials): string {
	const engine = new Tournament((error) => {
		throw error;
	});
	return engine.execute(BASE_URL_EXPRESSION.slice(1), { $credentials: credentials }) as string;
}

function outcome(run: () => string): string {
	try {
		return run();
	} catch (error) {
		return `refused: ${error instanceof Error ? error.message : String(error)}`; // the expression throws a string
	}
}

const URL_CASES = [
	' https://radioso.example.com/backend/// ',
	'https://radioso.example.com/backend/api/v1/',
	'https://radioso.example.com',
	'HTTPS://Radioso.Example.com',
	'http://localhost:3000',
	'http://127.0.0.1:8080/backend',
	'http://127.9.9.9',
	'http://[::1]:4000',
	'http://10.1.2.3',
	'http://172.16.0.1',
	'http://172.31.255.1',
	'http://192.168.1.10/backend',
	'http://backend:8080',
	'http://backend',
	'http://172.32.0.1',
	'http://172.15.0.1',
	'http://192.169.1.1',
	'http://11.0.0.1',
	'http://radioso.example.com',
	'http://example.com@10.0.0.1',
	'http://10.0.0.1@radioso.example.com',
	'http://my.internal',
	'http://[2001:db8::1]',
	'ftp://radioso.example.com',
	'radioso.example.com',
	'https://',
	'http://',
	' / ',
	'',
];

describe('Radioso credential', () => {
	const credential = new RadiosoApi();

	it('sends the service-account token as a bearer header', () => {
		expect(credential.authenticate).toMatchObject({
			properties: { headers: { Authorization: '=Bearer {{$credentials.token}}' } },
		});
	});

	it('tests itself against the workspace summary', () => {
		expect(credential.test.request).toMatchObject({
			method: 'GET',
			url: '/api/v1/workspace/summary',
			baseURL: BASE_URL_EXPRESSION,
		});
	});

	it('tests against the EU and US clouds', () => {
		expect(evaluateBaseUrl({ environment: 'eu' })).toBe('https://api.radioso.ai');
		expect(evaluateBaseUrl({ environment: 'us' })).toBe('https://api-us.radioso.ai');
	});

	it.each(URL_CASES)('tests against the same origin the node uses for %j, or refuses it as the node does', (customUrl) => {
		const credentials: RadiosoCredentials = { environment: 'custom', customUrl };
		expect(outcome(() => evaluateBaseUrl(credentials))).toBe(
			outcome(() => resolveBaseUrl(credentials)),
		);
	});

	it('offers the EU cloud, US cloud and self-hosted instances', () => {
		const instance = credential.properties.find((property) => property.name === 'environment');
		expect(instance?.default).toBe('eu');
		expect((instance?.options as Array<{ value: string }>).map((option) => option.value)).toEqual([
			'eu',
			'us',
			'custom',
		]);
	});
});

describe('resolveBaseUrl', () => {
	it('keeps the /backend path of a self-hosted URL and strips slashes and a pasted /api/v1', () => {
		expect(
			resolveBaseUrl({ environment: 'custom', customUrl: ' https://r.example.com/backend/// ' }),
		).toBe('https://r.example.com/backend');
		expect(
			resolveBaseUrl({ environment: 'custom', customUrl: 'https://r.example.com/backend/api/v1/' }),
		).toBe('https://r.example.com/backend');
	});

	it.each([
		'http://localhost:3000',
		'http://127.0.0.1',
		'http://[::1]:4000',
		'http://10.0.0.5',
		'http://172.20.1.1',
		'http://192.168.0.2',
		'http://backend:8080',
	])('accepts plain http for the private host %s', (customUrl) => {
		expect(resolveBaseUrl({ environment: 'custom', customUrl })).toBe(customUrl);
	});

	it.each([
		'http://radioso.example.com',
		'http://8.8.8.8',
		'http://172.32.0.1',
		'http://10.0.0.1@radioso.example.com',
		'ftp://radioso.example.com',
		'radioso.example.com',
	])('refuses %s', (customUrl) => {
		expect(() => resolveBaseUrl({ environment: 'custom', customUrl })).toThrow('https://');
	});

	it('does not fall back to a cloud when a custom URL is empty', () => {
		expect(() => resolveBaseUrl({ environment: 'custom', customUrl: ' / ' })).toThrow(
			'no API URL',
		);
	});
});
