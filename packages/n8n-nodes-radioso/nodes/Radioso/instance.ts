const EU_CLOUD_URL = 'https://api.radioso.ai';
const US_CLOUD_URL = 'https://api-us.radioso.ai';

export type RadiosoEnvironment = 'eu' | 'us' | 'custom';

export interface RadiosoCredentials {
	environment?: RadiosoEnvironment;
	customUrl?: string;
}

function withoutTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value[end - 1] === '/') end--;
	return value.slice(0, end);
}

/**
 * The API origin a credential points at. A custom URL must be https and loses trailing slashes so
 * request paths join cleanly. An empty one is an error rather than a silent fallback to the EU
 * cloud, because a token only works against the instance that issued it. Self-hosted URLs often
 * end in `/backend`, which is kept.
 */
export function resolveBaseUrl(credentials: RadiosoCredentials): string {
	if (credentials.environment === 'us') return US_CLOUD_URL;
	if (credentials.environment === 'custom') {
		const custom = withoutTrailingSlashes((credentials.customUrl ?? '').trim());
		if (custom === '') {
			throw new Error('The Radioso credential is set to a self-hosted instance but has no API URL.');
		}
		if (!custom.toLowerCase().startsWith('https://')) {
			throw new Error('The Radioso API URL must start with https://, because it carries the token.');
		}
		return custom;
	}
	return EU_CLOUD_URL;
}
