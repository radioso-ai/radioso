import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INode,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { radiosoProperties } from './descriptions';
import { describeApiError } from './errors';
import { resolveBaseUrl, type RadiosoCredentials } from './instance';
import {
	buildRequest,
	shapeResponse,
	type RadiosoRequest,
	type Resource,
} from './requests';

type Context = IExecuteFunctions | ILoadOptionsFunctions;

interface ApiResult {
	statusCode: number;
	body: unknown;
}

async function callRadioso(
	context: Context,
	request: RadiosoRequest,
): Promise<ApiResult> {
	const credentials = (await context.getCredentials('radiosoApi')) as RadiosoCredentials;
	const options: IHttpRequestOptions = {
		method: request.method,
		url: `${resolveBaseUrl(credentials)}${request.path}`,
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
	return { statusCode: response.statusCode, body: response.body };
}

/** Keeps errors that already carry n8n context; anything else is a transport failure. */
function toNodeError(node: INode, error: unknown, itemIndex: number): Error {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) return error;
	return new NodeApiError(node, error as JsonObject, {
		message: 'Could not reach Radioso',
		description:
			error instanceof Error
				? `${error.message}. Check the instance in the Radioso credential and that it is reachable from n8n.`
				: undefined,
		itemIndex,
	});
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
		credentials: [{ name: 'radiosoApi', required: true }],
		properties: radiosoProperties,
	};

	methods = {
		loadOptions: {
			async getAgents(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const { statusCode, body } = await callRadioso(this, {
					method: 'GET',
					path: '/api/v1/agents',
				});
				if (statusCode < 200 || statusCode >= 300) {
					const { message, description } = describeApiError(statusCode, body);
					throw new NodeApiError(this.getNode(), (body ?? {}) as JsonObject, {
						message,
						description,
						httpCode: String(statusCode),
					});
				}
				const agents = ((body as { agents?: Array<{ id: string; name: string }> }).agents ??
					[]) as Array<{ id: string; name: string }>;
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
				const { statusCode, body } = await callRadioso(this, request);
				if (statusCode < 200 || statusCode >= 300) {
					const { message, description } = describeApiError(statusCode, body);
					throw new NodeApiError(this.getNode(), (body ?? {}) as JsonObject, {
						message,
						description,
						httpCode: String(statusCode),
						itemIndex,
					});
				}
				output.push({
					json: shapeResponse(resource, operation, body) as IDataObject,
					pairedItem: { item: itemIndex },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					output.push({
						json: { error: error instanceof Error ? error.message : String(error) },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw toNodeError(this.getNode(), error, itemIndex);
			}
		}

		return [output];
	}
}
