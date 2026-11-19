interface DescribedApiError {
	message: string;
	description: string;
}

function parseBody(body: unknown): unknown {
	if (typeof body !== 'string') return body;
	try {
		return JSON.parse(body);
	} catch {
		return body;
	}
}

/** The server's own explanation: `{ error: { message } }`, or the rate limiter's top-level `message`. */
function serverMessage(body: unknown): string | undefined {
	const parsed = parseBody(body);
	if (typeof parsed !== 'object' || parsed === null) {
		return typeof parsed === 'string' && parsed !== '' ? parsed : undefined;
	}
	const record = parsed as Record<string, unknown>;
	const nested = record.error;
	if (typeof nested === 'object' && nested !== null) {
		const message = (nested as Record<string, unknown>).message;
		if (typeof message === 'string') return message;
	}
	return typeof record.message === 'string' ? record.message : undefined;
}

function retryAfterSeconds(body: unknown): number | undefined {
	const parsed = parseBody(body);
	if (typeof parsed !== 'object' || parsed === null) return undefined;
	const seconds = (parsed as Record<string, unknown>).retryAfterSeconds;
	return typeof seconds === 'number' ? seconds : undefined;
}

/** Turns a non-2xx Radioso response into the message and hint an n8n user sees on the node. */
export function describeApiError(statusCode: number, body: unknown): DescribedApiError {
	const detail = serverMessage(body);
	const withDetail = (hint: string) => (detail ? `${detail} ${hint}`.trim() : hint);

	switch (statusCode) {
		case 400:
			return {
				message: 'Radioso rejected the request',
				description: withDetail('Check the values you sent.'),
			};
		case 401:
			return {
				message: 'Radioso rejected the credential',
				description:
					'Use a service-account token (radioso_svc_v1_...) issued by this instance. It may be expired, revoked, or from the other cloud region.',
			};
		case 403:
			return {
				message: 'The token is not allowed to do this',
				description: withDetail(
					'Give the service account a role with access to this operation, or use another account.',
				),
			};
		case 404:
			return {
				message: 'Radioso could not find it',
				description: withDetail('Check the agent or conversation id belongs to this workspace.'),
			};
		case 409:
			return {
				message: 'Radioso could not apply the request right now',
				description: withDetail('Another change got there first. Run the step again.'),
			};
		case 413:
			return {
				message: 'The content is too large for Radioso',
				description: withDetail('Send a shorter document.'),
			};
		case 429: {
			const seconds = retryAfterSeconds(body);
			return {
				message: 'Radioso is rate limiting this token',
				description: seconds
					? `Wait ${seconds} seconds and run the step again, or enable Retry On Fail with a wait.`
					: 'Wait a minute and run the step again, or enable Retry On Fail with a wait.',
			};
		}
		default:
			return {
				message:
					statusCode >= 500 ? 'Radioso reported a server error' : `Radioso answered HTTP ${statusCode}`,
				description: withDetail('Try again; if it keeps failing, check the instance status.'),
			};
	}
}
