import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class RadiosoApi implements ICredentialType {
	name = 'radiosoApi';

	displayName = 'Radioso API';

	icon: Icon = { light: 'file:../icons/radioso.svg', dark: 'file:../icons/radioso.dark.svg' };

	documentationUrl = 'https://docs.radioso.ai/guides/n8n';

	properties: INodeProperties[] = [
		{
			displayName: 'Instance',
			name: 'environment',
			type: 'options',
			options: [
				{ name: 'EU Cloud', value: 'eu', description: 'https://api.radioso.ai' },
				{ name: 'US Cloud', value: 'us', description: 'https://api-us.radioso.ai' },
				{ name: 'Self-Hosted', value: 'custom' },
			],
			default: 'eu',
			description: 'Where your workspace lives. A token only works against the instance that issued it.',
		},
		{
			displayName: 'API URL',
			name: 'customUrl',
			type: 'string',
			default: '',
			placeholder: 'https://radioso.example.com/backend',
			description: 'The origin of your self-hosted Radioso API, without a trailing slash',
			displayOptions: { show: { environment: ['custom'] } },
		},
		{
			displayName: 'Service Account Token',
			name: 'token',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'A service-account token starting with radioso_svc_v1_, created under Settings, API access. A member role is enough for every operation in this node.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.token}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL:
				'={{$credentials.environment === "custom" ? $credentials.customUrl.trim().replace(/\\/+$/, "") : ($credentials.environment === "us" ? "https://api-us.radioso.ai" : "https://api.radioso.ai")}}',
			url: '/api/v1/workspace/summary',
			method: 'GET',
		},
	};
}
