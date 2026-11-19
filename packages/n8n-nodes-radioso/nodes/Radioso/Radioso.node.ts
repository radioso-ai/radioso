import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { radiosoProperties } from './descriptions';
import { describeApiError } from './errors';
import { RadiosoConfigError, resolveBaseUrl, type RadiosoCredentials } from './instance';
import { buildRequest, shapeResponse, type RadiosoRequest, type Resource } from './requests';

type Context = IExecuteFunctions | ILoadOptionsFunctions;

/**
 * Sends one authenticated request and returns the JSON body of a successful answer. A non-2xx
 * answer becomes a NodeApiError with the mapped message; a 2xx that is not a JSON object (an HTML
 * page from the wrong URL) and a credential that names no usable instance become
 * NodeOperationErrors.
 */
async function callRadioso(
	context: Context,
	request: RadiosoRequest,
	itemIndex?: number,
): Promise<Record<string, unknown>> {
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

	if (response.statusCode < 200 || response.statusCode >= 300) {
		const { message, description } = describeApiError(response.statusCode, response.body);
		throw new NodeApiError(node, (response.body ?? {}) as JsonObject, {
			message,
			description,
			httpCode: String(response.statusCode),
			itemIndex,
		});
	}
	if (typeof response.body !== 'object' || response.body === null) {
		throw new NodeOperationError(node, 'Radioso answered with something other than JSON', {
			itemIndex,
			description: `${baseUrl} did not return Radioso API JSON. A self-hosted API URL often ends in /backend.`,
		});
	}
	return response.body as Record<string, unknown>;
}

function sentence(text: string): string {
	return text.endsWith('.') ? text : `${text}.`;
}

/** Keeps errors that already carry n8n context; anything else is a transport failure. */
function toNodeError(node: INode, error: unknown, itemIndex: number): Error {
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

/** What a Continue On Fail item carries, so a workflow can branch on the cause. */
function failureJson(error: unknown): IDataObject {
	const failure: IDataObject = { error: error instanceof Error ? error.message : String(error) };
	const { description, httpCode } = error as { description?: unknown; httpCode?: unknown };
	if (typeof description === 'string') failure.description = description;
	if (typeof httpCode === 'string') failure.httpCode = httpCode;
	return failure;
}

export class Radioso implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Radioso',
		name: 'radioso',
		icon: { light: 'file:../../icons/radioso.svg', dark: 'file:../../icons/radioso.dark.svg' },
		group: ['input'],
		version: 1,
		subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
		description: 'Ask Radioso agents, search knowledge, add documents and read conversations',
		defaults: { name: 'Radioso' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'radiosoApi', required: true}],
		properties: radiosoProperties,
	};

	methods = {
		loadOptions: {
			async getAgents(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const body = await callRadioso(this, { method: 'GET', path: '/api/v1/agents' });
				const agents = (body.agents ?? []) as Array<{ id: string; name: string }>;
				return agents.map((agent) => ({ name: agent.name, value: agent.id }));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const resource = this.getNodeParameter('resource', 0) as Resource;
		const operation = this.getNodeParameter('operation', 0) as string;
		const output: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const request = buildRequest(this.getNode(), resource, operation, (name, fallback) =>
					this.getNodeParameter(name, itemIndex, fallback),
				);
				const body = await callRadioso(this, request, itemIndex);
				output.push({
					json: shapeResponse(resource, operation, body) as IDataObject,
					pairedItem: { item: itemIndex },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					output.push({ json: failureJson(error), pairedItem: { item: itemIndex } });
					continue;
				}
				throw toNodeError(this.getNode(), error, itemIndex);
			}
		}

		return [output];
	}
}
