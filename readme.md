# <img src="./frontend/public/radioso-logo.png" alt="Radioso logo" width="44" align="center" /> Radioso

**Self-hosted AI agents grounded in your knowledge.**

You can wire up LangChain and build a rocketship. You can get a PhD in dragging nodes around a low-code agent canvas. 
Or you can run Radioso, upload your documents, and have an assistant that knows what it's talking about — self-hosted, multi-provider, API-first, today. That is why we built Radioso. 

## Quick Start

**Prerequisites:** Node.js 22+, Docker Desktop, and at least one of `OPENAI_API_KEY`, `GEMINI_API_KEY`, or `ANTHROPIC_API_KEY`.

```bash
./run-dev.sh
```

The bootstrap prompts for your AI provider credentials, generates secrets, and starts the full stack. Register, upload a document, ask a question. Working conversational assistant with context in under five minutes.

In the Docker development stack, frontend and backend source changes are bind-mounted into the containers. TypeScript backend changes restart automatically, and backend prompt markdown under `backend/prompts/` is re-read on each request in development without a container restart.

For Enterprise Edition embed development, run:

```bash
./run-ee-dev.sh
```

This starts Postgres in Docker, builds and installs the commercial packages from `ee/packages` locally without saving them to the OSS package manifests, generates the local Enterprise Edition frontend routes from Enterprise feature manifests, updates `.env` with Enterprise Edition embed settings, and runs the backend, worker, frontend, and embed harness on the host. The normal `./run-dev.sh` path removes those generated routes before starting the OSS stack.

| Surface | URL |
|---|---|
| App | http://localhost:3000 |
| API | http://localhost:8080 |
| Embed test harness | http://127.0.0.1:4321 |

---

## Architecture

```
                    ┌─────────────────────────────────────────┐
                    │               Your content               │
                    │  (documents, FAQs, manuals, knowledge)   │
                    └──────────────────┬──────────────────────┘
                                       │ upload
                                       ▼
┌──────────────────────────────────────────────────────────────────┐
│                        Radioso Platform                          │
│                                                                  │
│   ┌─────────────┐    ┌──────────────┐    ┌──────────────────┐   │
│   │  Ingestion  │    │   Retrieval  │    │  Answer engine   │   │
│   │  worker     │───▶│  (pgvector + │───▶│  grounded on     │   │
│   │  chunk +    │    │   reranker)  │    │  your chunks     │   │
│   │  embed      │    └──────────────┘    └──────────────────┘   │
│   └─────────────┘                                               │
│                                                                  │
│   ┌──────────┐  ┌───────────┐  ┌───────────┐  ┌────────────┐   │
│   │  Web app │  │  REST API │  │  TS SDK   │  │ MCP server │   │
│   └──────────┘  └───────────┘  └───────────┘  └────────────┘   │
└──────────────────────────────────────────────────────────────────┘
         │               │               │              │
         ▼               ▼               ▼              ▼
    Browser /       Your backend    Your Node.js    Cursor /
    website embed   or scripts      application     Claude Desktop /
                                                    ChatGPT
```

The backend stores application state, document metadata, chunks, and vectors in Postgres with `pgvector`. Uploaded source files use the local filesystem in local development and GCS in cloud deployments. A background worker handles ingestion so uploads don't block the request path. The frontend, API, and worker all run in Docker Compose locally and on Cloud Run in production.

---

## Integration Points

### Website embed

One script tag. Paste it on any page of an approved origin. The launcher opens a Radioso-hosted chat iframe — no backend work required on the host site, and origin policy stays under your control.

### Web app

1. Run `./run-dev.sh`.
2. Open `http://localhost:3000`.
3. Register or sign in.
4. Let Radioso seed the starter documents for the workspace.
5. Wait for document processing to finish.
6. Ask one of the suggested questions in chat.

Open-source Radioso does not include transactional email. Registration creates a session immediately, and password reset is not exposed in the OSS auth API. Mail-backed account recovery belongs to Enterprise Edition modules.

Authenticated dashboard URLs are workspace-first. After sign-in, the app navigates under `/w/<workspace-public-route-key>/...`. Older `/account/<account-id>/...` dashboard links still work, but they redirect to the canonical workspace URL after the app restores the correct organization and workspace context.

### Worker dispatch

Document ingestion always creates a durable PostgreSQL processing job first. Worker dispatch controls how the API wakes worker services after that durable job exists.

Local runs default to `WORKER_DISPATCH_DRIVER=noop`, which keeps the worker polling the database. Google Cloud deployments can use `WORKER_DISPATCH_DRIVER=cloud-tasks` with `WORKER_TASKS_QUEUE_LOCATION`, `WORKER_TASKS_QUEUE_NAME`, `WORKER_TASKS_CRAWL_QUEUE_NAME`, `WORKER_TASKS_SERVICE_URL`, and `WORKER_TASKS_INVOKER_SERVICE_ACCOUNT`.

Broker-based deployments can use `WORKER_DISPATCH_DRIVER=amqp` with a RabbitMQ-compatible AMQP 0-9-1 broker:

```bash
WORKER_DISPATCH_DRIVER=amqp
WORKER_AMQP_URL=amqp://localhost:5672
WORKER_AMQP_QUEUE_NAME=radioso-document-jobs
WORKER_AMQP_CRAWL_QUEUE_NAME=radioso-website-crawls
WORKER_AMQP_PREFETCH=1
```

AMQP messages contain job ids and trace metadata only. PostgreSQL remains the source of truth for job state, retries, leases, and recovery if broker dispatch is unavailable after a job has already been queued. Document processing and website crawling use separate queues so long-running crawls do not block document work. AMQP mode is an eventing plus polling hybrid: broker messages wake workers quickly, and the worker polling loop stays active for recovery and scheduled retry eligibility. Delayed retries are governed by the job table's `available_at` value, not by broker-delayed delivery.

### API auth flow

Register a user:

```bash
curl -sS \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"verysecurepassword"}' \
  http://localhost:8080/api/v1/auth/register
```

That response includes `workspaceId`, `workspacePublicRouteKey`, and a session cookie. You can also log in later to save a fresh session cookie:

```bash
curl -sS -c cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"verysecurepassword"}' \
  http://localhost:8080/api/v1/auth/login
```

The login response also includes `workspacePublicRouteKey`. Browser URLs use that public route key, while backend workspace APIs and token reveal flows continue to use the internal `workspaceId`.

List workspaces or reveal the workspace API token with the session cookie:

```bash
curl -sS -b cookies.txt \
  http://localhost:8080/api/v1/workspace

curl -sS -b cookies.txt \
  http://localhost:8080/api/v1/account/workspaces/<workspace-id>/token
```

Each workspace payload includes both `id` and `publicRouteKey`. Use `id` for API calls that require a workspace identifier. Use `publicRouteKey` when you need to inspect or build the canonical dashboard URL.

If a workspace token or public embed link is ever exposed, rotate it from the settings screen instead of relying on disable-and-re-enable toggles.

### Assistant and retrieval APIs

Use the assistant API for human-facing chat. It owns conversation history, source-channel context, assistant identity, direct social replies, and the decision to call retrieval when evidence is needed.

```bash
curl -sS \
  -H "Authorization: Bearer <workspace-token>" \
  -H 'Content-Type: application/json' \
  -d '{"message":"What does the FAQ say about refunds?","stream":false}' \
  http://localhost:8080/api/v1/assistant/chat
```

Use retrieval APIs when you want grounded search or answer generation over workspace context without assistant persona or chat routing.

```bash
curl -sS \
  -H "Authorization: Bearer <workspace-token>" \
  -H 'Content-Type: application/json' \
  -d '{"query":"refund policy"}' \
  http://localhost:8080/api/v1/retrieval/search

curl -sS \
  -H "Authorization: Bearer <workspace-token>" \
  -H 'Content-Type: application/json' \
  -d '{"query":"What does the FAQ say about refunds?"}' \
  http://localhost:8080/api/v1/retrieval/answer
```

Assistant conversations are listed from `GET /api/v1/history` and fetched from `GET /api/v1/history/<conversation-id>`. Shared workspace settings are read and merge-updated through `GET /api/v1/settings` and `PUT /api/v1/settings`, with separate `assistant`, `retrieval`, and `channels` sections.

Assistant and retrieval responses include diagnostic metadata that identifies whether the work ran as assistant direct, assistant retrieval-backed, retrieval-only, or MCP capability traffic.

### Website crawler provider

Radioso exposes an OSS website crawler provider port at `POST /api/v1/document/crawl`. The route accepts a website URL, calls the bundled `radioso-crawler` provider by default, and publishes returned pages through the normal document ingestion pipeline.

Application composition can register a different crawler provider for custom deployments. Crawl limits are controlled with `WEBSITE_CRAWLER_DEFAULT_LIMIT` and `WEBSITE_CRAWLER_MAX_LIMIT`.

`GET /api/v1/document/crawl/jobs` lists recent crawl jobs for the current workspace with their status, requested URL, page count, and last error. The dashboard Knowledge Base page uses it to display a status banner for in-flight and recently completed crawls. See `docs/website-crawler.md` for the full request and response shape.

Website crawls run in a separate process from document chunking and embeddings. Locally, `docker-compose.yml` and `docker-compose.dev.yml` add a `backend-crawler-worker` service alongside `backend-worker` (running `npm run start:crawler-worker` or `dev:crawler-worker`). On Cloud Run, Terraform provisions a dedicated `radioso-<env>-crawler-worker` service and wires its run.app URL into the backend's `WORKER_TASKS_CRAWL_SERVICE_URL` automatically — no manual override needed. When the env var is unset (e.g. self-hosted single-process deployments) crawls reuse `WORKER_TASKS_SERVICE_URL`. See `docs/website-crawler.md` for the full deployment topology.

Set `WEBSITE_CRAWLER_ENABLED=false` to disable the crawler entirely. The API hides the crawl routes (404), the dashboard hides the "Crawl Website" button, and the crawler worker entrypoints exit on startup so the container can be removed.

### TypeScript SDK

The SDK chat facade is for assistant chat. Use the REST retrieval endpoints above for retrieval-only search or grounded answers when you do not want assistant behavior.

```ts
import { createRadiosoClient } from "@radioso/typescript-sdk";
import { readFile } from "node:fs/promises";

const client = createRadiosoClient({
  baseUrl: "http://localhost:8080",
  apiToken: process.env.RADIOSO_API_TOKEN!,
});

await client.documents.create({
  title: "Support FAQ",
  content: "...",
  source: { kind: "website", url: "https://example.com/docs" },
});

const file = await readFile("./handbook.pdf");
await client.documents.importFile({
  file,
  filename: "handbook.pdf",
  title: "Support handbook",
  mimeType: "application/pdf",
});

const response = await client.chat.create({
  message: "What does the FAQ say about refunds?",
  stream: false,
});

for await (const event of client.chat.stream({ message: "Summarize the FAQ" })) {
  if (event.type === "chunk") process.stdout.write(event.text);
}
```

### MCP server

The standalone `packages/radioso-mcp-server/` package exposes your workspace as an MCP context layer. Cursor can use a local server directly. Claude Desktop, ChatGPT deep-research, and other hosted remote MCP clients require a public HTTPS deployment plus compatible auth.

---

## Docs

- [MCP client setup](./docs/mcp-client-setup.md)
- [TypeScript SDK getting started](./docs/typescript-sdk-getting-started.md)
- [TypeScript SDK basic usage](./docs/typescript-sdk-basic-usage.md)
- [Assistant execution model](./docs/assistant-execution-model.md)
- [Observability](./docs/oss-saas-observability.md)

Full configuration reference, API docs, retrieval tuning guide, and deployment documentation: [docs/README.md](./docs/README.md).

---

## Contributing

```
backend/         Express API and background document worker
frontend/        Next.js application
typescript-sdk/  First-party TypeScript SDK
packages/        Shared local packages (includes MCP server)
infra/           Docker Compose and Terraform
docs/            Product and SDK guides
```

Run `./run-dev.sh` to get a full local stack. Detailed setup and follow-on guides are indexed in [docs/README.md](./docs/README.md).
