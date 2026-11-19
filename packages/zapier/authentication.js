'use strict'

const { instanceHost, normalizeInstanceUrl, radiosoRequest } = require('./lib/client')

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
  if (!/^https?:\/\/[^/\s]+/i.test(normalizeInstanceUrl(bundle.authData.instance_url))) {
    throw new z.errors.Error(
      'Instance URL must start with https:// (or http:// for a local deployment), for example https://api.radioso.ai.',
      'invalid_instance_url',
      400,
    )
  }
  return radiosoRequest(z, bundle, { path: '/workspace/summary' })
}

module.exports = {
  type: 'custom',
  fields: [
    {
      key: 'instance_url',
      label: 'Instance URL',
      type: 'string',
      required: true,
      default: EU_CLOUD,
      helpText:
        'Where your Radioso workspace runs. Use `https://api.radioso.ai` for the EU cloud, `https://api-us.radioso.ai` for the US cloud, or the backend origin of your self-hosted deployment. A token only works on the instance that issued it.',
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
  connectionLabel: (z, bundle) =>
    `${bundle.inputData.workspace_name || instanceHost(bundle.inputData.instance_url)}`.trim(),
}
