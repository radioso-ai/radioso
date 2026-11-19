# @radioso/n8n-nodes-radioso

The Radioso community node for [n8n](https://n8n.io). A workflow can ask a Radioso agent a question, search your knowledge, add a document, or read a conversation, and the node doubles as a tool for n8n's AI Agent node.

Full guide: [docs.radioso.ai/guides/n8n](https://docs.radioso.ai/guides/n8n).

## Install

On a self-hosted n8n, open **Settings → Community Nodes → Install** and enter `@radioso/n8n-nodes-radioso`.

## Credentials

Create a **Radioso API** credential:

- **Instance**: EU Cloud (`https://api.radioso.ai`), US Cloud (`https://api-us.radioso.ai`), or Self-Hosted with the origin of your backend API.
- **Service Account Token**: a `radioso_svc_v1_...` token from **Settings → API access** in Radioso. The `member` role covers every operation.

n8n tests the credential with `GET /api/v1/workspace/summary`.

## Operations

| Resource | Operation | Radioso route |
|---|---|---|
| Agent | Ask | `POST /api/v1/assistant/chat` |
| Knowledge | Search | `POST /api/v1/retrieval/search` |
| Knowledge | Answer | `POST /api/v1/retrieval/answer` |
| Document | Create | `POST /api/v1/document` |
| Conversation | Get | `GET /api/v1/history/chat/{conversationId}` |

The agent field loads from `GET /api/v1/agents`. Document processing is asynchronous: **Create** returns once Radioso accepts the document, and it is searchable when its status is ready.

Replying as an operator and resolving decisions need a signed-in dashboard session in Radioso, so a service-account token can't call them and the node does not include them.

## Example workflow

An n8n workflow that answers a question and keeps the conversation going. Import it through **Import from URL or file**, then pick your credential and agent.

```json
{
  "nodes": [
    {
      "name": "Ask the agent",
      "type": "@radioso/n8n-nodes-radioso.radioso",
      "typeVersion": 1,
      "position": [0, 0],
      "parameters": {
        "resource": "agent",
        "operation": "ask",
        "message": "What are your opening hours?",
        "additionalFields": {}
      }
    },
    {
      "name": "Ask a follow-up",
      "type": "@radioso/n8n-nodes-radioso.radioso",
      "typeVersion": 1,
      "position": [240, 0],
      "parameters": {
        "resource": "agent",
        "operation": "ask",
        "message": "And on public holidays?",
        "additionalFields": {
          "conversationId": "={{ $json.conversationId }}"
        }
      }
    }
  ],
  "connections": {
    "Ask the agent": { "main": [[{ "node": "Ask a follow-up", "type": "main", "index": 0 }]] }
  }
}
```

## Development

```bash
pnpm install              # from the repo root
cd packages/n8n-nodes-radioso
pnpm run lint             # n8n's node linter
pnpm test
pnpm run build
pnpm run dev              # a local n8n with the node loaded
```

Releases publish from GitHub Actions with an npm provenance statement (`.github/workflows/publish-n8n-node.yml`), which n8n requires for verified community nodes.

## License

MIT. See `LICENSE`.
