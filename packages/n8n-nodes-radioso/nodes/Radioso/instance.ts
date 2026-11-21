const EU_CLOUD_URL = 'https://api.radioso.ai';
const US_CLOUD_URL = 'https://api-us.radioso.ai';
const API_PREFIX = '/api/v1';

export type RadiosoEnvironment = 'eu' | 'us' | 'custom';

export interface RadiosoCredentials {
	environment?: RadiosoEnvironment;
	customUrl?: string;
}

/** A credential that cannot name a usable instance; reported as a setup problem, not a network one. */
export class RadiosoConfigError extends Error {}

export const INSTANCE_URL_RULE =
	'The Radioso API URL must start with https://. Plain http:// is accepted only for localhost, private network addresses and single-word host names, because the URL carries the token';

function trimSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value[end - 1] === '/') end--;
	return value.slice(0, end);
}

function isDigits(value: string): boolean {
	return value !== '' && value.length <= 3 && [...value].every((c) => c >= '0' && c <= '9');
}

/** The host of `rest` (a URL without its scheme), lower-cased, without userinfo or port. */
function hostOf(rest: string): string {
	let authority = rest;
	for (const mark of ['/', '?', '#']) {
		const at = authority.indexOf(mark);
		if (at >= 0) authority = authority.slice(0, at);
	}
	authority = authority.slice(authority.lastIndexOf('@') + 1);
	return authority.startsWith('[')
		? authority.slice(0, authority.indexOf(']') + 1)
		: authority.split(':')[0];
}

/**
 * Plain http is accepted only where the token cannot cross the public internet: loopback,
 * private IPv4 literals and single-label hostnames such as a Docker service name.
 *
 * The credential test is a declarative expression in RadiosoApi.credentials.ts that restates this
 * rule; tests/credential.test.ts runs both over the same URLs so they cannot disagree.
 */
function mayUseHttp(host: string): boolean {
	if (host === 'localhost' || host === '[::1]') return true;
	const octets = host.split('.');
	if (octets.length === 4 && octets.every(isDigits)) {
		const [a, b] = octets.map(Number);
		return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
	}
	return host !== '' && !host.includes('.') && !host.includes(':');
}

/**
 * The API origin a credential points at. A pasted `/api/v1` and trailing slashes are dropped;
 * `/backend` is kept, because self-hosted URLs often end in it. An empty or refused custom URL is
 * an error rather than a silent fallback to the EU cloud, because a token only works against the
 * instance that issued it.
 */
export function resolveBaseUrl(credentials: RadiosoCredentials): string {
	if (credentials.environment === 'us') return US_CLOUD_URL;
	if (credentials.environment !== 'custom') return EU_CLOUD_URL;

	let url = trimSlashes((credentials.customUrl ?? '').trim());
	if (url.endsWith(API_PREFIX)) url = trimSlashes(url.slice(0, -API_PREFIX.length));
	if (url === '') {
		throw new RadiosoConfigError(
			'The Radioso credential is set to a self-hosted instance but has no API URL',
		);
	}
	const lower = url.toLowerCase();
	const secure = lower.startsWith('https://');
	const plain = lower.startsWith('http://');
	const host = hostOf(lower.slice(secure ? 8 : 7));
	if (host === '' || !(secure || (plain && mayUseHttp(host)))) {
		throw new RadiosoConfigError(INSTANCE_URL_RULE);
	}
	return url;
}
