import { instanceHost, radiosoRequest } from './lib/client.js'

const EU_CLOUD = 'https://api.radioso.ai'

/**
 * Custom authentication: where the instance lives and a service-account token for one workspace.
 * The test call needs `workspace.summary.read`; the `member` role already holds it and every
 * other permission the steps in this app use.
 *
 * The summary response does not name the workspace, so the connection label comes from the
 * optional "Workspace name" field and falls back to the instance host.
 */
const testAuth = async (z, bundle) => {
  const summary = await radiosoRequest(z, bundle, { path: '/workspace/summary' })
  if (typeof summary.documentCount !== 'number') {
    throw new z.errors.Error(
      'That URL answered, but not like a Radioso API. Set Instance URL to the URL your API answers on.',
      'invalid_instance_url',
      400,
    )
  }
  return summary
}

export default {
  type: 'custom',
  fields: [
    {
      key: 'instance_url',
      label: 'Instance URL',
      type: 'string',
      required: true,
      default: EU_CLOUD,
      helpText:
        'The URL your Radioso API answers on, over https. Use `https://api.radioso.ai` for the EU cloud or `https://api-us.radioso.ai` for the US cloud. A self-hosted deployment often serves the API at its app address plus `/backend`, such as `https://app.example.com/backend`. A token only works on the instance that issued it.',
    },
    {
      key: 'api_token',
      label: 'Service-account token',
      type: 'password',
      required: true,
      helpText:
        'Create a service account with the `member` role in Radioso under Settings, API access, and paste its token here. It starts with `radioso_svc_v1_`.',
    },
    {
      key: 'workspace_name',
      label: 'Workspace name',
      type: 'string',
      required: false,
      helpText: 'Optional. Names this connection in Zapier, which helps when you connect more than one workspace.',
    },
  ],
  test: testAuth,
  // In a connection-label function the auth fields are in `authData`; `inputData` holds the test response.
  connectionLabel: (z, bundle) =>
    `${bundle.authData.workspace_name || instanceHost(bundle.authData.instance_url)}`.trim(),
}
