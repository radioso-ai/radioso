import type { INodeProperties } from 'n8n-workflow';

const agentOption = (): INodeProperties => ({
	displayName: 'Agent Name or ID',
	name: 'agentId',
	type: 'options',
	typeOptions: { loadOptionsMethod: 'getAgents' },
	default: '',
	description:
		'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
});

export const radiosoProperties: INodeProperties[] = [
	{
		displayName: 'Resource',
		name: 'resource',
		type: 'options',
		noDataExpression: true,
		options: [
			{ name: 'Agent', value: 'agent' },
			{ name: 'Conversation', value: 'conversation' },
			{ name: 'Document', value: 'document' },
			{ name: 'Knowledge', value: 'knowledge' },
		],
		default: 'agent',
	},

	// Agent
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['agent'] } },
		options: [
			{
				name: 'Ask',
				value: 'ask',
				action: 'Ask an agent',
				description: 'Send a message to a published agent and get its reply',
			},
		],
		default: 'ask',
	},
	{
		...agentOption(),
		displayOptions: { show: { resource: ['agent'], operation: ['ask'] } },
	},
	{
		displayName: 'Message',
		name: 'message',
		type: 'string',
		typeOptions: { rows: 3 },
		default: '',
		required: true,
		description: 'What to say to the agent, up to 4000 characters',
		displayOptions: { show: { resource: ['agent'], operation: ['ask'] } },
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: { resource: ['agent'], operation: ['ask'] } },
		options: [
			{
				displayName: 'Conversation ID',
				name: 'conversationId',
				type: 'string',
				default: '',
				description:
					'Continue an existing conversation with the conversationId from a previous reply. The conversation keeps its agent, so Agent is ignored. Leave empty to start a new conversation. Retry On Fail sends the message again, and a retried first message opens a second conversation.',
			},
			{
				displayName: 'Language',
				name: 'userExpectedLocale',
				type: 'string',
				default: '',
				placeholder: 'en-GB',
				description: 'The language the person writes in, as a BCP 47 tag',
			},
			{
				displayName: 'Time Zone',
				name: 'userTimeZone',
				type: 'string',
				default: '',
				placeholder: 'Europe/Berlin',
				description: 'IANA time zone used to resolve dates such as "tomorrow"',
			},
		],
	},

	// Knowledge
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['knowledge'] } },
		options: [
			{
				name: 'Answer',
				value: 'answer',
				action: 'Answer from knowledge',
				description: 'Get a grounded answer with citations, without an agent persona',
			},
			{
				name: 'Search',
				value: 'search',
				action: 'Search knowledge',
				description: 'Return the document passages that match a query',
			},
		],
		default: 'search',
	},
	{
		displayName: 'Query',
		name: 'query',
		type: 'string',
		default: '',
		required: true,
		description: 'The question or search text, up to 4000 characters',
		displayOptions: { show: { resource: ['knowledge'] } },
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: { resource: ['knowledge'] } },
		options: [
			agentOption(),
			{
				displayName: 'Max Results',
				name: 'topK',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 100 },
				default: 10,
				description: 'Max number of results to return. Applies to Search only.',
			},
		],
	},

	// Document
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['document'] } },
		options: [
			{
				name: 'Add or Replace',
				value: 'create',
				action: 'Add or replace a document',
				description:
					'Add a text document to the workspace, or replace the one with the same External Document ID. Processing is asynchronous: a document is searchable once its status is ready.',
			},
		],
		default: 'create',
	},
	{
		displayName: 'Title',
		name: 'title',
		type: 'string',
		default: '',
		required: true,
		displayOptions: { show: { resource: ['document'], operation: ['create'] } },
	},
	{
		displayName: 'Content',
		name: 'content',
		type: 'string',
		typeOptions: { rows: 6 },
		default: '',
		required: true,
		description: 'The document text. Radioso chunks and embeds it in the background.',
		displayOptions: { show: { resource: ['document'], operation: ['create'] } },
	},
	{
		displayName: 'Metadata',
		name: 'metadata',
		type: 'json',
		default: '',
		placeholder: '{"category": "pricing"}',
		description:
			'Optional JSON object of attributes. Values must be strings, numbers, booleans or null.',
		displayOptions: { show: { resource: ['document'], operation: ['create'] } },
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: { resource: ['document'], operation: ['create'] } },
		options: [
			{
				displayName: 'External Document ID',
				name: 'externalDocumentId',
				type: 'string',
				default: '',
				description:
					'An ID from your own system, such as a record ID. Sending the same ID again replaces the document it created, so a workflow can keep one document in sync with a record. Unchanged content comes back ready at once.',
			},
		],
	},

	// Conversation
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['conversation'] } },
		options: [
			{
				name: 'Get',
				value: 'get',
				action: 'Get a conversation',
				description: 'Read a conversation transcript',
			},
		],
		default: 'get',
	},
	{
		displayName: 'Conversation ID',
		name: 'conversationId',
		type: 'string',
		default: '',
		required: true,
		displayOptions: { show: { resource: ['conversation'], operation: ['get'] } },
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: { resource: ['conversation'], operation: ['get'] } },
		options: [
			{
				displayName: 'Message Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 100 },
				default: 50,
				description: 'Max number of results to return',
			},
			{
				displayName: 'Message Offset',
				name: 'offset',
				type: 'number',
				typeOptions: { minValue: 0 },
				default: 0,
				description: 'How many messages to skip',
			},
		],
	},
];
