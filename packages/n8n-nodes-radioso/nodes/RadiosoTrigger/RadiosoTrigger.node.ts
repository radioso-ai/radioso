import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { apiError, sendRadioso } from '../Radioso/client';
import {
	checkSignature,
	createSubscription,
	deleteSubscription,
	EVENT_TYPES,
	readStored,
	selectedEventTypes,
	subscriptionExists,
	type Send,
} from '../Radioso/events';

function sender(context: IHookFunctions): Send {
	return async (request) => {
		const { statusCode, body } = await sendRadioso(context, request);
		return { statusCode, body };
	};
}

function wanted(context: IHookFunctions): { targetUrl: string; eventTypes: string[] } {
	const eventTypes = selectedEventTypes(context.getNodeParameter('events', []));
	if (eventTypes.length === 0) {
		throw new NodeOperationError(context.getNode(), 'Choose at least one event.');
	}
	return { targetUrl: context.getNodeWebhookUrl('default') as string, eventTypes };
}

export class RadiosoTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Radioso Trigger',
		name: 'radiosoTrigger',
		icon: { light: 'file:../../icons/radioso.svg', dark: 'file:../../icons/radioso.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts a workflow when something happens in Radioso',
		defaults: { name: 'Radioso Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'radiosoApi', required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				options: [...EVENT_TYPES],
				default: [],
				required: true,
				description:
					'The events that start the workflow. Radioso pushes each one to this node as it happens. Decision Pending only notifies: a teammate decides in the Radioso Inbox.',
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const stored = readStored(this.getWorkflowStaticData('node').subscription);
				const result = await subscriptionExists(sender(this), stored, wanted(this));
				if (result.failure) {
					throw apiError(this.getNode(), result.failure.statusCode, result.failure.body, undefined, 'events');
				}
				if (!result.exists) delete this.getWorkflowStaticData('node').subscription;
				return result.exists;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const { stored, failure } = await createSubscription(sender(this), wanted(this));
				if (failure) throw apiError(this.getNode(), failure.statusCode, failure.body, undefined, 'events');
				// The signing secret is returned once, here; the webhook needs it to verify each push.
				this.getWorkflowStaticData('node').subscription = stored as unknown as IDataObject;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node');
				const stored = readStored(data.subscription);
				if (!stored) return true;
				const failure = await deleteSubscription(sender(this), stored);
				if (failure) {
					// Like n8n's own trigger nodes: a failed cleanup must not block deactivation.
					this.logger.warn(
						`Radioso Trigger could not delete subscription ${stored.subscriptionId} (HTTP ${failure.statusCode}); remove it in Radioso if it is still listed.`,
					);
					return false;
				}
				delete data.subscription;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const request = this.getRequestObject();
		const response = this.getResponseObject();
		const rawBody = (request as { rawBody?: Buffer }).rawBody;
		const stored = readStored(this.getWorkflowStaticData('node').subscription);

		const verdict =
			rawBody === undefined || stored === undefined
				? 'bad_signature'
				: checkSignature({
						rawBody: rawBody.toString('utf8'),
						secret: stored.signingSecret,
						timestamp: request.header('x-radioso-timestamp'),
						signatureHeader: request.header('x-radioso-signature'),
						nowSeconds: Math.floor(Date.now() / 1000),
					});
		if (verdict !== 'valid') {
			response.status(401).json({ error: verdict });
			return { noWebhookResponse: true };
		}

		// The body is authenticated, so it is emitted as received even if it is not an event envelope.
		return { workflowData: [this.helpers.returnJsonArray(this.getBodyData() as IDataObject)] };
	}
}
