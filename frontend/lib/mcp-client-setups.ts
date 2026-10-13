import { buildConverseClientConfig } from '@/lib/mcp-converse-client-config'

export type McpClientId = 'claude-desktop' | 'claude-code' | 'cursor' | 'other'

export interface McpClientSetup {
  id: McpClientId
  name: string
  steps: readonly string[]
  buildSnippet: (mcpUrl: string, secret: string) => string
  openAccess?: {
    name: string
    buildSnippet: (mcpUrl: string) => string
  }
}

/** Server name the generated configuration registers the agent under. */
export const MCP_SERVER_NAME = 'radioso'

const buildClaudeCodeCommand = (mcpUrl: string, secret: string) =>
  `claude mcp add --transport http ${MCP_SERVER_NAME} ${mcpUrl} \\\n  --header "Authorization: Bearer ${secret}"`

export const MCP_CLIENT_SETUPS: readonly McpClientSetup[] = [
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    steps: [
      'Open Claude Desktop → Settings → Developer → Edit config.',
      'Merge this into claude_desktop_config.json and restart Claude Desktop.',
    ],
    buildSnippet: buildConverseClientConfig,
    openAccess: {
      name: 'Claude',
      buildSnippet: (mcpUrl) => buildConverseClientConfig(mcpUrl),
    },
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    steps: ['Run this in your terminal:'],
    buildSnippet: buildClaudeCodeCommand,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    steps: [
      'Open Cursor → Settings → MCP → Add new server,',
      'or merge this into ~/.cursor/mcp.json.',
    ],
    buildSnippet: buildConverseClientConfig,
    openAccess: {
      name: 'Cursor',
      buildSnippet: (mcpUrl) => buildConverseClientConfig(mcpUrl),
    },
  },
  {
    id: 'other',
    name: 'Other MCP client',
    steps: ['Point your client at the MCP server URL with this bearer credential, or paste the standard mcpServers block:'],
    buildSnippet: buildConverseClientConfig,
  },
]

const buildChatGptConnectorSteps = (mcpUrl: string) => [
  'In ChatGPT, enable Developer Mode and create a custom app.',
  `Set the MCP server endpoint to ${mcpUrl}.`,
  'For open access, choose no authentication. For protected access, issue an MCP credential with Connect a client and configure that credential as static bearer authentication.',
]

const buildOpenAiResponsesConfig = (mcpUrl: string) => `const response = await client.responses.create({
  model: 'gpt-5',
  tools: [{
    type: 'mcp',
    server_label: '${MCP_SERVER_NAME}',
    server_url: '${mcpUrl}',
    require_approval: 'never',
  }],
  input: 'Ask the agent a question.',
})`

/**
 * The public-access variants live beside the credentialed client setups so endpoint
 * syntax stays consistent while the authentication boundary remains explicit.
 */
export const MCP_OPEN_ACCESS_CLIENT_SETUPS = [
  ...MCP_CLIENT_SETUPS.flatMap((setup) => setup.openAccess ? [{
    id: setup.id,
    name: setup.openAccess.name,
    buildSnippet: setup.openAccess.buildSnippet,
  }] : []),
  { id: 'chatgpt', name: 'ChatGPT', buildSteps: buildChatGptConnectorSteps },
  { id: 'openai-responses', name: 'OpenAI Responses API', buildSnippet: buildOpenAiResponsesConfig },
] as const

export const DEFAULT_MCP_CLIENT_ID: McpClientId = 'claude-desktop'

/** The catalog entry used when the client is unknown, such as when rotating an existing connection. */
export const GENERIC_MCP_CLIENT_ID: McpClientId = 'other'

export const getMcpClientSetup = (id: McpClientId): McpClientSetup =>
  MCP_CLIENT_SETUPS.find((setup) => setup.id === id) ?? MCP_CLIENT_SETUPS[MCP_CLIENT_SETUPS.length - 1]
