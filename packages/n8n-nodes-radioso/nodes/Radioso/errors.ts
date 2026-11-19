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

export function errorCode(body: unknown): string | undefined {
	const parsed = parseBody(body);
	if (typeof parsed !== 'object' || parsed === null) return undefined;
	const nested = (parsed as Record<string, unknown>).error;
	if (typeof nested !== 'object' || nested === null) return undefined;
	const code = (nested as Record<string, unknown>).code;
	return typeof code === 'string' ? code : undefined;
}

function retryAfterSeconds(body: unknown): number | undefined {
	const parsed = parseBody(body);
	if (typeof parsed !== 'object' || parsed === null) return undefined;
	const seconds = (parsed as Record<string, unknown>).retryAfterSeconds;
	return typeof seconds === 'number' ? seconds : undefined;
}

/** Turns a non-2xx Radioso response into the message and hint an n8n user sees on the node. */
export function describeApiError(
	statusCode: number,
	body: unknown,
	scope: 'action' | 'events' = 'action',
): DescribedApiError {
	const detail = serverMessage(body);
	const withDetail = (hint: string) => (detail ? `${detail} ${hint}`.trim() : hint);

	const code = errorCode(body);

	switch (statusCode) {
		case 400:
			if (code === 'invalid_target_url') {
				return {
					message: 'Radioso cannot deliver events to this n8n instance',
					description: withDetail(
						'Radioso needs a public https:// webhook URL for n8n. Set WEBHOOK_URL on n8n to its public address, or use the Radioso Poll Trigger node instead.',
					),
				};
			}
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
			if (code === 'event_type_not_permitted') {
				return {
					message: 'The token cannot read one of the chosen event types',
					description: withDetail(
						'Conversation events need a role that reads history; Decision Pending also needs the takeover permission. Use the member role or drop the event type.',
					),
				};
			}
			return {
				message: 'The token is not allowed to do this',
				description: withDetail(
					'Give the service account a role with access to this operation, or use another account.',
				),
			};
		case 404:
			if (scope === 'events') {
				return {
					message: 'This Radioso instance has no event API',
					description: withDetail(
						'Upgrade the instance, or check the API URL in the credential: a self-hosted URL often ends in /backend.',
					),
				};
			}
			return {
				message: 'Radioso could not find it',
				description: withDetail('Check the agent or conversation id belongs to this workspace.'),
			};
		case 409:
			if (code === 'event_subscription_limit_reached') {
				return {
					message: 'This workspace has reached its limit of event subscriptions',
					description: withDetail(
						'Delete subscriptions that are no longer used in Settings, or switch this workflow to the Radioso Poll Trigger node.',
					),
				};
			}
			return {
				message: 'Radioso could not apply the request right now',
				description: withDetail('Another change got there first. Run the step again.'),
			};
		case 503:
			if (code === 'encryption_not_configured') {
				return {
					message: 'This Radioso instance cannot store webhook secrets yet',
					description: withDetail('Ask the operator to configure encryption, or use the Radioso Poll Trigger node.'),
				};
			}
			return {
				message: 'Radioso reported a server error',
				description: withDetail('Try again; if it keeps failing, check the instance status.'),
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
