import type {
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { apiError, instanceUrl, requireJsonObject, sendRadioso } from '../Radioso/client';
import { errorCode } from '../Radioso/errors';
import {
	EVENT_TYPES,
	pollEvents,
	selectedEventTypes,
	type EventsPage,
	type FetchPage,
	type PollState,
} from '../Radioso/events';

/** Statuses that mean the saved position is no longer usable: expired, or issued for other types. */
function cursorRejected(statusCode: number, body: unknown): boolean {
	if (statusCode === 410) return true;
	const code = errorCode(body);
	return statusCode === 400 && (code === 'invalid_cursor' || code === 'cursor_filter_mismatch');
}

function pageFetcher(context: IPollFunctions): FetchPage {
	return async (query) => {
		const response = await sendRadioso(context, {
			method: 'GET',
			path: '/api/v1/workspace/events',
			qs: query,
		});
		if (cursorRejected(response.statusCode, response.body)) return { expired: true };
		if (response.statusCode < 200 || response.statusCode >= 300) {
			throw apiError(context.getNode(), response.statusCode, response.body, undefined, 'events');
		}
		const body = requireJsonObject(context.getNode(), response);
		if (!Array.isArray(body.events) || typeof body.nextCursor !== 'string') {
			throw new NodeOperationError(context.getNode(), 'Radioso answered with something other than an event page', {
				description: `${response.baseUrl} did not return the event log. A self-hosted API URL often ends in /backend.`,
			});
		}
		return { page: body as unknown as EventsPage };
	};
}

export class RadiosoPollTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Radioso Poll Trigger',
		name: 'radiosoPollTrigger',
		icon: { light: 'file:../../icons/radioso.svg', dark: 'file:../../icons/radioso.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description:
			'Starts a workflow when something happens in Radioso, by checking for new events on a schedule',
		defaults: { name: 'Radioso Poll Trigger' },
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'radiosoApi', required: true }],
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				options: [...EVENT_TYPES],
				default: [],
				required: true,
				description:
					'The events that start the workflow. Use this node when Radioso cannot reach n8n; otherwise Radioso Trigger delivers events as they happen.',
			},
		],
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const types = selectedEventTypes(this.getNodeParameter('events', []));
		if (types.length === 0) throw new NodeOperationError(this.getNode(), 'Choose at least one event.');

		const data = this.getWorkflowStaticData('node');
		const { events, state } = await pollEvents(pageFetcher(this), data as PollState, {
			types,
			manual: this.getMode() === 'manual',
			baseUrl: await instanceUrl(this),
		});
		Object.assign(data, state);

		if (events.length === 0) return null;
		return [events.map((event) => ({ json: event as unknown as IDataObject }))];
	}
}
