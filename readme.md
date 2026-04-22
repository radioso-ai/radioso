# <img src="./frontend/public/radioso-logo.png" alt="Radioso logo" width="44" align="center" /> Radioso

Run Radioso locally with Docker, upload documents, and ask grounded questions against them. If all goes well, you will spend more time using it than reading this file, which is the healthiest possible relationship with a README.

## Quick Start

### Prerequisites

- Node.js 22+
- Docker Desktop or another Docker engine with `docker compose`
- At least one supported model provider key
  - `OPENAI_API_KEY`
  - or `GEMINI_API_KEY`
  - or `ANTHROPIC_API_KEY`

`Node.js` is required because `./run-dev.sh` uses a small Node-based bootstrap script before the containers come up.

### Start The Stack

From the project root, run:

```bash
./run-dev.sh
```

This is the intended local run path. It:

- checks local prerequisites
- creates or reuses `backend/.env`
- prompts for the AI provider and required credentials
- generates missing secrets such as `SESSION_COOKIE_SECRET`, `WORKSPACE_TOKEN_SECRET`, and `WEBSITE_EMBED_SECRET`
- configures uploaded document storage to use the local filesystem by default
- builds and starts Postgres, the backend API, the background worker, and the frontend with Docker Compose
- waits until the frontend and backend are reachable

When it finishes successfully, open:

- App: `http://localhost:3000`
- API: `http://localhost:8080`
- Embed test harness: `http://127.0.0.1:4321` after running `node scripts/serve-embed-test-site.mjs`

### Success Looks Like This

- `http://localhost:3000` loads
- you can register or sign in
- you can upload a document
- Radioso returns an answer grounded in that document

## Website Embed Smoke Test

Use the local harness when you want to test the website embed launcher against both an approved and a blocked origin without building a separate site.

Start the harness from the repo root:

```bash
node scripts/serve-embed-test-site.mjs
```

Then open:

- Approved-origin test: `http://127.0.0.1:4321`
- Blocked-origin test: `http://localhost:4321`

Important: the website embed allowlist must include the exact origin, including the port. For this harness that usually means `http://127.0.0.1:4321`, not just `http://127.0.0.1`.

## Choose Your Path

### Use The Web App

1. Run `./run-dev.sh`.
2. Open `http://localhost:3000`.
3. Register or sign in.
4. Let Radioso seed the starter documents for the workspace.
5. Wait for document processing to finish.
6. Ask one of the suggested questions in chat.

This is the fastest path if you want to click around the product and verify that the full app works.

### Use The API Or SDK Only

You do not need to open the web app at all.

Register a new user and save the session cookie:

```bash
curl -sS -c cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"verysecurepassword"}' \
  http://localhost:8080/api/v1/auth/register
```

That response includes `workspaceId`. You can also log in instead:

```bash
curl -sS -c cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"verysecurepassword"}' \
  http://localhost:8080/api/v1/auth/login
```

Reveal the workspace API token with the session cookie:

```bash
curl -sS -b cookies.txt \
  http://localhost:8080/api/v1/account/workspaces/<workspace-id>/token
```

If you need to list workspaces first:

```bash
curl -sS -b cookies.txt \
  http://localhost:8080/api/v1/workspace
```

The token response looks like:

```json
{"token":"sk_proj_..."}
```

If a workspace token or public embed link is ever exposed, rotate it from the settings screen instead of relying on disable/re-enable toggles.

A valid provider key is required for both document processing and chat responses.

### Use The MCP Server

If you want Radioso to act as a context layer for MCP-capable clients, use the standalone package in `packages/radioso-mcp-server/`.

Install and build it from the repo:

```bash
cd packages/radioso-mcp-server
npm install
npm run build
```

The package also includes safe smoke commands that do not touch the local Radioso PostgreSQL volume:

```bash
cd packages/radioso-mcp-server
npm run smoke:http
npm run smoke:redis
```

`smoke:http` uses the backend's in-memory test app. `smoke:redis` uses the same in-memory backend plus a shared Redis runtime, sourcing Redis from `RADIOSO_MCP_SMOKE_REDIS_URL` when provided or from a disposable local Redis process/container otherwise.

Start the remote HTTP server against a running Radioso instance:

```bash
RADIOSO_BASE_URL=http://localhost:8080 \
RADIOSO_MCP_BIND_HOST=127.0.0.1 \
RADIOSO_MCP_BIND_PORT=8787 \
RADIOSO_MCP_SIGNING_SECRET=dev-signing-secret \
node dist/src/cli/http.js
```

`RADIOSO_MCP_SIGNING_SECRET` is mandatory in remote mode and must be a real deployment secret. The reserved stdio compatibility secret is only valid for the local stdio entrypoint.

The backend and the remote MCP server must share the same `RADIOSO_MCP_SIGNING_SECRET`. The MCP package uses it to sign MCP-attributed chat traffic, and the backend verifies that signature before marking a conversation as MCP-originated in history.

Set `RADIOSO_MCP_REDIS_URL` to move MCP access sessions and approval grants into a shared Redis store for multi-instance deployments. Leave it blank to stay in the documented in-memory single-node mode. You can also point `RADIOSO_MCP_WORKSPACE_POLICIES_PATH` at a JSON file with workspace-specific tool overrides when different workspaces need different MCP catalogs.

Exchange a workspace token for an MCP access token:

```bash
ACCESS_TOKEN=$(
  curl -s http://127.0.0.1:8787/v1/auth/exchange \
    -H 'content-type: application/json' \
    -d '{
      "radiosoApiToken": "sk_proj_example",
      "clientName": "operator-shell",
      "requestedTools": ["describe_capabilities","list_documents","answer_grounded","create_document"]
    }' \
  | jq -r '.accessToken'
)
```

For project-local clients such as Cursor, the repo now includes [.cursor/mcp.json](./.cursor/mcp.json). Export a short-lived bearer token for that config with:

```bash
eval "$(
  RADIOSO_WORKSPACE_TOKEN=sk_proj_example \
  npm --prefix packages/radioso-mcp-server run -s token:exchange
)"
```

See [docs/mcp-client-setup.md](./docs/mcp-client-setup.md) for the current client matrix:
- Cursor can use the local HTTP server directly.
- Anthropic API clients can use a public deployment plus a pre-minted bearer token.
- Claude and Claude Desktop remote connectors require a public HTTPS deployment plus connector-compatible auth.
- ChatGPT apps and OpenAI-hosted remote MCP flows also require a public HTTPS deployment plus app-compatible auth, and OpenAI API deep-research use should stay read-only unless you intentionally relax approval policy.

Initialize MCP and list the granted tools:

```bash
curl -s http://127.0.0.1:8787/mcp \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-11-25' \
  -d '{
    "jsonrpc": "2.0",
    "id": "init-1",
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-11-25",
      "capabilities": {},
      "clientInfo": { "name": "operator-shell", "version": "1.0.0" }
    }
  }'

curl -s http://127.0.0.1:8787/mcp \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-11-25' \
  -d '{
    "jsonrpc": "2.0",
    "method": "notifications/initialized",
    "params": {}
  }'

curl -s http://127.0.0.1:8787/mcp \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-11-25' \
  -d '{
    "jsonrpc": "2.0",
    "id": "tools-1",
    "method": "tools/list",
    "params": {}
  }'
```

Governed write tools use the same endpoint, but require an approval token from `POST /v1/approvals` before the `tools/call`.

The remote package keeps MCP transport, session exchange, approval gating, audit logging, workspace policy resolution, and shared-store runtime concerns separate from backend application modules. It requires `GET /api/v1/workspace/mcp/context` on the target backend and uses that route to negotiate workspace identity and supported MCP capabilities before a session grants tools. The local stdio mode still exists for compatibility, but remote HTTP is now the primary MCP surface.

## Assistant Execution Model

Radioso deliberately codifies a separation between live chat and any future background assistant work.

- Normal chat stays on the live request path, including authenticated chat, anonymous or embedded chat, and assistant bootstrap greetings.
- Those interactions remain immediate and streaming when requested. Radioso does not silently queue a normal chat turn behind the scenes.
- Long-running assistant-adjacent work belongs in an explicit deferred path once a real background runtime exists. Eval replay is still an inline workflow today, even though it is a plausible future candidate for that path.

For the operator-facing explanation, see [docs/assistant-execution-model.md](./docs/assistant-execution-model.md).

### Enterprise Architecture FAQ

- **Is live chat queue-backed?** No. Normal chat stays synchronous and streaming so users get an immediate answer or an explicit failure instead of a silent handoff into background work.
- **Does Radioso support durable background processing?** Yes for document processing today. Chat-related deferred execution is reserved for future long-running workflows and is not substituted automatically for live conversation turns.
- **What is the product contract?** Radioso treats interactive conversation and background work as separate modes. Live chat is optimized for responsiveness, while any future deferred workflow must be explicit, inspectable, and independently operated.

## TypeScript SDK

The repo includes a TypeScript SDK with the package name `@radioso/typescript-sdk`.

### Create A Client

Get the API token from either the web app `Settings -> Developer API -> Reveal API token` or the API-only `curl` flow above.

```ts
import { createRadiosoClient } from "@radioso/typescript-sdk";

const client = createRadiosoClient({
  baseUrl: "http://localhost:8080",
  apiToken: process.env.RADIOSO_API_TOKEN!,
});
```

### Upload Documents

```ts
await client.documents.create({
  title: "FAQ",
  content: "Radioso can answer questions grounded in uploaded content.",
  metadata: {
    category: "support",
    published: true,
  },
});
```

You can confirm the documents are available:

```ts
const documents = await client.documents.list({ limit: 10 });
console.log(documents);
```

### Ask Questions

```ts
const response = await client.chat.create({
  query: "What does the FAQ say about uploaded content?",
  stream: false,
});

console.log(response.answer);
```

### Stream The Answer

```ts
for await (const event of client.chat.stream({
  query: "Summarize the FAQ",
})) {
  if (event.type === "chunk") {
    process.stdout.write(event.textDelta);
  }

  if (event.type === "error") {
    throw event.error;
  }
}
```

### SDK Notes

- `baseUrl` should be the Radioso server origin.
- The SDK sends `Authorization: Bearer <token>`.
- If you want to work on the SDK from this repo, the source lives in `typescript-sdk/`.
- More SDK guides live in `docs/`, including `docs/typescript-sdk-getting-started.md` and `docs/typescript-sdk-basic-usage.md`.

## For Contributors

```text
backend/         Express API and background document worker
frontend/        Next.js application
typescript-sdk/  First-party SDK for the public API
packages/        Shared local packages
packages/radioso-mcp-server/  Standalone MCP server package for workspace-scoped context access
infra/           Docker Compose and Terraform
docs/            Product and SDK guides
```

## Common Settings To Tune

You usually do not need to change settings on day one. Tune them when retrieval is clearly too noisy, too narrow, or chunking is doing something a little too creative with your documents.

### Tune By Symptom

| If this is happening | Try this first |
| --- | --- |
| answers are missing relevant evidence | raise `vectorTopK`, keep `rerankEnabled: true`, review `similarityThreshold` |
| answers include weak or noisy context | raise `similarityThreshold`, lower `vectorTopK`, keep `answerSupportPolicy: "strict"` |
| question rewriting is changing user intent | disable `queryRewriteEnabled` temporarily or add targeted rewrite instructions |
| chunks are too fragmented | increase `structuredMinChunkSize` or `fixedWindowChunkSize` |
| chunks are too broad | lower `structuredMaxChunkSize` or `fixedWindowChunkSize` |

### Retrieval Settings

| Setting | Good starting point | Change it when | Typical effect |
| --- | --- | --- | --- |
| `queryRewriteEnabled` | `true` | user questions are being misinterpreted before search | broadens or normalizes search queries |
| `rerankEnabled` | `true` | top matches are relevant but badly ordered | improves final ranking |
| `vectorTopK` | `20` | relevant evidence is often missing | increases or reduces candidate recall |
| `similarityThreshold` | `0.2` | weak matches are slipping into answers | filters low-similarity chunks |
| `rerankTopK` | `20` | you want to rerank more or fewer candidates | changes how many results reach reranking |
| `conversationMode` | `guided` | answers feel too terse or too exploratory | controls whether the assistant stays direct, adds a small focused continuation, or expands into broader grounded discovery |
| `answerSupportPolicy` | `strict` | you want safer or looser answer behavior | controls whether unsupported answers are rewritten into safer conversational misses or left closer to the original model text |
| `citationDisplayEnabled` | `true` | you want cleaner output or easier debugging | shows or hides citations |

### Ingestion Settings

| Setting | Good starting point | Change it when | Typical effect |
| --- | --- | --- | --- |
| `chunkingStrategy` | `structured_semantic` | document structure is poor or inconsistent | switches between structure-aware and windowed chunking |
| `fixedWindowChunkSize` | `1200` | chunks are too small or too broad in fixed-window mode | changes chunk size |
| `fixedWindowChunkOverlap` | `150` | context is split across chunk boundaries | increases continuity between chunks |
| `structuredMinChunkSize` | `200` | structure-aware chunks are too fragmented | raises the floor for small chunks |
| `structuredMaxChunkSize` | `1200` | structure-aware chunks are too broad | caps large chunks |

### General Settings For Chat Bootstrap

Use General Settings for assistant identity and first-turn behavior. Keep retrieval tuning in Retrieval Settings, and keep language request-scoped.

| Setting | Good starting point | Change it when | Typical effect |
| --- | --- | --- | --- |
| `assistantName` | empty | you want the bot to introduce itself consistently | gives the greeting a stable name |
| `assistantRole` | empty | users need a clearer explanation of what the bot does | frames the assistant's purpose |
| `greetingInstruction` | empty | the greeting tone should be more formal, warmer, shorter, or brand-specific | shapes the opening style without turning settings into a full prompt editor |
| `assistantDefaultLocale` | empty | dashboard chat should default to one locale when no request hint is present | fallback locale only; request-level locale still wins |
| `proactiveGreetingEnabled` | `false` | new chats should open with an assistant-first greeting | seeds a first message for fresh authenticated and public conversations |

### Update Retrieval Settings Via API

These endpoints use the workspace API token you revealed earlier.

```bash
curl -sS \
  -X PUT \
  -H "Authorization: Bearer $RADIOSO_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "queryRewriteEnabled": true,
    "semanticRewriteInstructions": "",
    "lexicalRewriteInstructions": "",
    "answerSupportPolicy": "strict",
    "rerankEnabled": true,
    "vectorTopK": 20,
    "similarityThreshold": 0.2,
    "rerankTopK": 20,
    "citationDisplayEnabled": true,
    "metadataRules": [],
    "customInstruction": ""
  }' \
  http://localhost:8080/api/v1/settings/retrieval
```

### Update Ingestion Settings Via API

```bash
curl -sS \
  -X PUT \
  -H "Authorization: Bearer $RADIOSO_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "chunkingStrategy": "structured_semantic",
    "fixedWindowChunkSize": 1200,
    "fixedWindowChunkOverlap": 150,
    "structuredMinChunkSize": 200,
    "structuredMaxChunkSize": 1200
  }' \
  http://localhost:8080/api/v1/settings/ingestion
```

If you change ingestion settings and want existing documents to use them, queue reprocessing:

```bash
curl -sS \
  -X POST \
  -H "Authorization: Bearer $RADIOSO_API_TOKEN" \
  http://localhost:8080/api/v1/settings/ingestion/reprocess
```

### Update General Settings Via API

```bash
curl -sS \
  -X PUT \
  -H "Authorization: Bearer $RADIOSO_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "anonymousChatEnabled": true,
    "websiteEmbedEnabled": true,
    "websiteEmbedAllowedOrigins": ["https://example.com"],
    "websiteEmbedLauncherLabel": "Chat with Marta",
    "websiteEmbedLauncherPosition": "bottom-right",
    "assistantName": "Marta",
    "assistantRole": "Workspace document assistant",
    "greetingInstruction": "Warm, concise, and practical",
    "assistantDefaultLocale": "en",
    "proactiveGreetingEnabled": true
  }' \
  http://localhost:8080/api/v1/settings/general
```

For website popups or other embedded entry points, pass `userExpectedLocale` on the chat request. That locale hint overrides the workspace default for the new conversation greeting.

When website embed is enabled, General Settings also returns a copyable script tag that loads `radioso-embed.js`. Install that snippet on an approved origin only. The launcher stays thin; the actual assistant runs in a Radioso-hosted iframe so origin checks and chat runtime stay under Radioso control.

The host page can add optional static script attributes for per-site behavior:

- `data-radioso-locale="it-IT"` localizes common widget copy and the initial assistant bootstrap greeting for a brand-new conversation.
- `data-radioso-initial-state="open"` starts the widget expanded instead of collapsed.
- `data-radioso-collapsed-avatar-url="https://cdn.example.com/avatar.gif"` uses a custom image or GIF for the collapsed launcher icon.

Authenticated chat, anonymous public chat, and the website widget all expose a `New chat` action so visitors can clear the current thread and start over without leaving the surface.

## Troubleshooting And Operations

### Useful Commands

If you want to switch providers or re-enter credentials:

```bash
./run-dev.sh --reconfigure
```

If you want Compose logs attached to the current terminal:

```bash
./run-dev.sh --attach
```

If startup fails, inspect the stack logs:

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.dev.yml logs
```

### Services And Ports

The default local stack started by the bootstrap includes:

- PostgreSQL with `pgvector` on port `5432`
- Backend API on port `8080`
- Background document worker
- Frontend on port `3000`
- Shared local document storage mounted for both backend runtimes

### Configuration

The bootstrap writes `backend/.env` using the contract in `backend/.env.example`.

Common values:

```env
PORT=8080
DATABASE_URL=postgres://postgres:postgres@localhost:5432/radioso
LLM_PROVIDER=openai
DOCUMENT_STORAGE_DRIVER=local
DOCUMENT_STORAGE_LOCAL_PATH=../.context/document-storage
PUBLIC_CHAT_BASE_URL=http://localhost:3000/chat
```

For local Docker runs, uploaded source files are stored on a shared filesystem path so the API and worker containers see the same files. The default path is `../.context/document-storage` relative to `backend/`.

For cloud deploys, set `DOCUMENT_STORAGE_DRIVER=gcs` and provide `DOCUMENT_STORAGE_BUCKET`. The current Terraform stack does that automatically for GCP.

Local development keeps the background worker in polling mode. The GCP Terraform deployment uses Cloud Tasks for request-driven wake-ups, but the worker-task service also runs the durable queue poller as a safety net so queued jobs can still recover if task dispatch fails.

The cloud worker dispatch path uses these settings:

```env
WORKER_DISPATCH_DRIVER=cloud-tasks
WORKER_TASKS_QUEUE_LOCATION=us-central1
WORKER_TASKS_QUEUE_NAME=radioso-document-processing
WORKER_TASKS_SERVICE_URL=https://<worker-service-url>
WORKER_TASKS_INVOKER_SERVICE_ACCOUNT=<worker-task-invoker>@<project>.iam.gserviceaccount.com
DOCUMENT_PROCESSING_JOB_LEASE_MS=300000
```

Backend-serving and worker-serving capacity are configured independently in Terraform via `backend_min_instances` / `backend_max_instances` and `worker_min_instances` / `worker_max_instances`. Keep `worker_min_instances >= 1`; the worker service relies on one always-on instance so the durable queue can recover enqueue or retry dispatch failures.

If you already know what you need, you can pre-populate `backend/.env` before running the stack.

The bootstrap expects ports `3000`, `5432`, and `8080` to be free unless they are already used by this Radioso stack.
