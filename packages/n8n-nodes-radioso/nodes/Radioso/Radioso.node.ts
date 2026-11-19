import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { radiosoProperties } from './descriptions';
import { buildRequest, shapeResponse, type Resource } from './requests';
import { callRadioso, toNodeError } from './client';

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
