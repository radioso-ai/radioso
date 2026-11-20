import type {
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
	IPollFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import { describeApiError } from './errors';
import type { RadiosoRequest } from './requests';
import { RadiosoConfigError, resolveBaseUrl, type RadiosoCredentials } from './instance';

export type Context = IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions | IPollFunctions;

export interface RadiosoResponse {
	statusCode: number;
	body: unknown;
	baseUrl: string;
}

/**
 * Sends one authenticated request and returns the status and body whatever they are. A credential
 * that names no usable instance becomes a NodeOperationError before anything is sent.
 */
export async function sendRadioso(
	context: Context,
	request: RadiosoRequest,
	itemIndex?: number,
): Promise<RadiosoResponse> {
	const node = context.getNode();
	const credentials = (await context.getCredentials('radiosoApi')) as RadiosoCredentials;
	let baseUrl: string;
	try {
		baseUrl = resolveBaseUrl(credentials);
	} catch (error) {
		// resolveBaseUrl only throws RadiosoConfigError: a credential that names no usable instance.
		const message = error instanceof RadiosoConfigError ? error.message : String(error);
		throw new NodeOperationError(node, message, { itemIndex });
	}

	const options: IHttpRequestOptions = {
		method: request.method,
		url: `${baseUrl}${request.path}`,
		qs: request.qs,
		body: request.body,
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		timeout: request.timeoutMs,
	};
	const response = (await context.helpers.httpRequestWithAuthentication.call(
		context,
		'radiosoApi',
		options,
	)) as { statusCode: number; body: unknown };
	return { statusCode: response.statusCode, body: response.body, baseUrl };
}

/** The NodeApiError an n8n user sees for a non-2xx Radioso answer. */
export function apiError(
	node: INode,
	statusCode: number,
	body: unknown,
	itemIndex?: number,
	scope: 'action' | 'events' = 'action',
): NodeApiError {
	const { message, description } = describeApiError(statusCode, body, scope);
	return new NodeApiError(node, (body ?? {}) as JsonObject, {
		message,
		description,
		httpCode: String(statusCode),
		itemIndex,
	});
}

/**
 * Sends one request and returns the JSON body of a successful answer. A non-2xx answer becomes a
 * NodeApiError with the mapped message; a 2xx that is not a JSON object (an HTML page from the
 * wrong URL) becomes a NodeOperationError.
 */
export async function callRadioso(
	context: Context,
	request: RadiosoRequest,
	itemIndex?: number,
): Promise<Record<string, unknown>> {
	const node = context.getNode();
	const response = await sendRadioso(context, request, itemIndex);
	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw apiError(node, response.statusCode, response.body, itemIndex);
	}
	return requireJsonObject(node, response, itemIndex);
}

/** A 2xx that is not a JSON object (an HTML page from the wrong URL) is a setup problem. */
export function requireJsonObject(
	node: INode,
	response: RadiosoResponse,
	itemIndex?: number,
): Record<string, unknown> {
	if (typeof response.body !== 'object' || response.body === null) {
		throw new NodeOperationError(node, 'Radioso answered with something other than JSON', {
			itemIndex,
			description: `${response.baseUrl} did not return Radioso API JSON. A self-hosted API URL often ends in /backend.`,
		});
	}
	return response.body as Record<string, unknown>;
}

/** The API origin the credential names, or a setup error. */
export async function instanceUrl(context: Context): Promise<string> {
	const credentials = (await context.getCredentials('radiosoApi')) as RadiosoCredentials;
	try {
		return resolveBaseUrl(credentials);
	} catch (error) {
		// resolveBaseUrl only throws RadiosoConfigError: a credential that names no usable instance.
		const message = error instanceof RadiosoConfigError ? error.message : String(error);
		throw new NodeOperationError(context.getNode(), message);
	}
}

function sentence(text: string): string {
	return text.endsWith('.') ? text : `${text}.`;
}

/** Keeps errors that already carry n8n context; anything else is a transport failure. */
export function toNodeError(node: INode, error: unknown, itemIndex: number): Error {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) return error;
	return new NodeApiError(node, error as JsonObject, {
		message: 'Could not reach Radioso',
		description:
			error instanceof Error
				? `${sentence(error.message)} Check the instance in the Radioso credential and that it is reachable from n8n.`
				: undefined,
		itemIndex,
	});
}

