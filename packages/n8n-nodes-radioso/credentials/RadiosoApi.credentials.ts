import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/**
 * The API origin for the credential test. It restates `resolveBaseUrl` (nodes/Radioso/instance.ts)
 * as an n8n expression, because a declarative test cannot call code; tests/credential.test.ts
 * runs both over the same URLs. A refused URL makes the expression throw, so the test never sends
 * the token to an origin the node would refuse. It uses no globals such as `String`, `Number` or
 * `Error`, which n8n's expression sandbox does not guarantee.
 */
export const BASE_URL_EXPRESSION = [
	'={{(() => {',
	"const c = $credentials; if (c.environment === 'us') return 'https://api-us.radioso.ai';",
	"if (c.environment !== 'custom') return 'https://api.radioso.ai';",
	"let u = ((c.customUrl || '') + '').trim();",
	"const cut = () => { while (u.endsWith('/')) u = u.slice(0, -1); }; cut();",
	"if (u.endsWith('/api/v1')) { u = u.slice(0, -7); cut(); }",
	"if (u === '') throw 'The Radioso credential is set to a self-hosted instance but has no API URL';",
	"const l = u.toLowerCase(); const secure = l.startsWith('https://'); const plain = l.startsWith('http://');",
	"let a = l.slice(secure ? 8 : 7);",
	"for (const m of ['/', '?', '#']) { const i = a.indexOf(m); if (i >= 0) a = a.slice(0, i); }",
	"a = a.slice(a.lastIndexOf('@') + 1);",
	"const h = a.startsWith('[') ? a.slice(0, a.indexOf(']') + 1) : a.split(':')[0];",
	"const o = h.split('.'); const v4 = o.length === 4 && o.every((x) => x !== '' && x.length <= 3 && [...x].every((d) => d >= '0' && d <= '9'));",
	"const n = o.map((x) => +x);",
	"const priv = h === 'localhost' || h === '[::1]' || (v4 ? (n[0] === 127 || n[0] === 10 || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) || (n[0] === 192 && n[1] === 168)) : (h !== '' && !h.includes('.') && !h.includes(':')));",
	"if (h === '' || !(secure || (plain && priv))) throw 'The Radioso API URL must start with https://. Plain http:// is accepted only for localhost, private network addresses and single-word host names, because the URL carries the token';",
	'return u;',
	'})()}}',
].join(' ');

export class RadiosoApi implements ICredentialType {
	name = 'radiosoApi';

	displayName = 'Radioso API';

	icon: Icon = { light: 'file:../icons/radioso.svg', dark: 'file:../icons/radioso.dark.svg' };

	documentationUrl = 'https://github.com/radioso-ai/radioso/tree/main/packages/n8n-nodes-radioso#readme';

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
			description: 'The https:// origin of your self-hosted Radioso API, often ending in /backend. Plain http:// is accepted only for localhost, private network addresses and single-word host names.',
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
			baseURL: BASE_URL_EXPRESSION,
			url: '/api/v1/workspace/summary',
			method: 'GET',
		},
	};
}
