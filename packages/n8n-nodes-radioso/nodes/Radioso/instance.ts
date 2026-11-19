const EU_CLOUD_URL = 'https://api.radioso.ai';
const US_CLOUD_URL = 'https://api-us.radioso.ai';

export type RadiosoEnvironment = 'eu' | 'us' | 'custom';

export interface RadiosoCredentials {
	environment?: RadiosoEnvironment;
	customUrl?: string;
	token?: string;
}

/**
 * The API origin a credential points at. A custom URL loses trailing slashes so request paths
 * join cleanly; an empty custom URL is an error rather than a silent fallback to the EU cloud,
 * because a token only works against the instance that issued it.
 */
export function resolveBaseUrl(credentials: RadiosoCredentials): string {
	if (credentials.environment === 'us') return US_CLOUD_URL;
	if (credentials.environment === 'custom') {
		const custom = (credentials.customUrl ?? '').trim().replace(/\/+$/, '');
		if (custom === '') {
			throw new Error('The Radioso credential is set to a custom instance but has no URL.');
		}
		return custom;
	}
	return EU_CLOUD_URL;
}
