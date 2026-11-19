import { describe, expect, it } from 'vitest';

import { RadiosoApi } from '../credentials/RadiosoApi.credentials';
import { resolveBaseUrl } from '../nodes/Radioso/instance';

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
		});
	});

	it('tests against the same instances the node resolves', () => {
		const baseUrl = String(credential.test.request.baseURL);
		expect(baseUrl).toContain(resolveBaseUrl({ environment: 'eu' }));
		expect(baseUrl).toContain(resolveBaseUrl({ environment: 'us' }));
		expect(baseUrl).toContain('$credentials.customUrl');
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
	it('maps the clouds and trims a custom URL', () => {
		expect(resolveBaseUrl({ environment: 'eu' })).toBe('https://api.radioso.ai');
		expect(resolveBaseUrl({ environment: 'us' })).toBe('https://api-us.radioso.ai');
		expect(resolveBaseUrl({ environment: 'custom', customUrl: 'https://r.example.com/' })).toBe(
			'https://r.example.com',
		);
	});

	it('does not fall back to a cloud when a custom URL is empty', () => {
		expect(() => resolveBaseUrl({ environment: 'custom', customUrl: ' ' })).toThrow('no URL');
	});
});
