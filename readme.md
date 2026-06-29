# Radioso
# <img src="./frontend/public/radioso-icon.svg" alt="Radioso logo" width="44" align="center" />
## Self-hosted conversational agents, grounded in your data and following your rules.

You can wire up LangChain and build a rocketship. You can get a degree in dragging nodes around a low-code canvas. Or you can run one script, and get a conversational agent that answers from what you actually gave it, follows the flows you define, and behaves the way you tell it to — self-hosted, multi-provider, API-first, today.

Every message runs through a plain loop: read it, decide what the turn needs, do that, write the reply. The interesting part is what you plug into the loop — grounded retrieval, your own behavioral rules, multi-turn flows — and that is what the rest of this document is about.

---

## Quick Start

**Prerequisites:** Node.js 24+ and Docker Desktop. A provider API key (OpenAI, Gemini, or Anthropic) is optional at startup — you can enter one when prompted, or skip it and add it later in the app under Settings → Credentials.

```bash
./run-dev.sh
```

The bootstrap generates secrets and starts the full stack. It offers to set an AI provider key; enter one now or press Enter to skip and add it in the app. Register, add a key if you skipped it, upload a document, ask a question — a working conversational assistant with context in a few minutes.

In the Docker development stack, frontend and backend source changes are bind-mounted into the containers. TypeScript backend changes restart automatically, and backend prompt markdown under `backend/prompts/` is re-read on each request in development without a container restart.

By default the Docker stack uses the Compose project name `radioso` and publishes the app on port 3000, the API on port 8080, and Postgres on port 5432. To run more than one local stack, set a distinct `COMPOSE_PROJECT_NAME` together with `RADIOSO_FRONTEND_PORT`, `RADIOSO_BACKEND_PORT`, and `RADIOSO_POSTGRES_PORT` before running `./run-dev.sh`. In Conductor workspaces, `./run-dev.sh` uses the workspace `CONDUCTOR_PORT` allocation automatically.

For Enterprise Edition development, run:

```bash
./run-ee-dev.sh
```

This starts Postgres in Docker, builds and installs the commercial packages from `ee/packages` locally without saving them to the OSS package manifests, generates the local Enterprise Edition frontend routes from Enterprise feature manifests, updates `.env` with embed settings, and runs the backend, worker, frontend, and embed harness on the host. The normal `./run-dev.sh` path removes those generated routes before starting the OSS stack.

| Surface | URL |
|---|---|
| App | http://localhost:3000 |
| API | http://localhost:8080 |
| Embed test harness | http://127.0.0.1:4321 |

---

## The conversation engine

Every human-facing assistant turn takes one path: the conversation engine. It is a loop with four phases.

1. **Gather** — interpret the message: intent, query rewrite, routing.
2. **Select** — decide which skill or skills the turn needs.
3. **Dispatch** — run the selected skills through one invocation port.
4. **Compose** — build the reply from what the skills returned and the steering that applies.

The loop holds the mechanism; the behavior lives in small units you register. Adding a capability or a rule means registering a unit, not editing the loop. The engine is the only turn path the assistant uses — there is no separate fallback.

It works through a product-independent contract. The reusable turn vocabulary lives in `packages/conversation-contract/`, and the pure runtime loop lives in `packages/conversation-engine/`. Workspace auth, billing, retrieval, settings, persistence, and streaming stay in Radioso-owned adapters that the engine reaches through ports.

### Skills, directives, and routines

The assistant works with three kinds of unit on a turn.

- A **skill** is something the assistant *does* — grounded retrieval, a lookup, a submission. A skill is dispatched through one port and returns a result. Retrieval is the `retrieval.answer` skill, not a privileged step.
- A **directive** is a standing rule that shapes *how* the assistant behaves. It pairs a condition with an action: when the condition holds, the action is added to the turn's instructions. A directive is matched and added to the prompt; it is never dispatched and returns nothing. For example: when the customer sounds anxious, slow down and confirm before acting.
- A **routine** is a stateful, multi-turn flow that carries a task across turns — collecting the values it needs, taking an action, and confirming. Unlike a skill or directive, a routine is **authored as data**: an operator builds it in the agent's Routines settings, and the platform compiles it into a graph the engine runs and resumes turn to turn. The built-in "contact a human" flow — collect an email, collect a message, submit, confirm — is itself an authored routine.

The key point: **skills act, directives steer, routines carry a flow across turns.** Directives and skill-emitted guidance share one steering type, so the composer reads a single ordered set rather than two separate channels.

Condition matching is never a keyword list, because Radioso is multilingual. A condition that depends on the situation is judged by the model, by meaning, in any language.

### Extending behavior

Skills and directives are declared in a catalog and registered at application composition. Routines are different: they are authored as data per agent — in the Routines settings or over the API at `/api/v1/agents/<agentId>/routines` — then validated and published, with no redeploy. Skills also expose a read-only catalog over HTTP at `GET /api/v1/skills` (see [REST API](#rest-api)). Each directive match and skill dispatch is recorded in the turn trace with the reason it applied, so the steering behind any answer can be inspected.

For the full model, see [Assistant turn spine](./docs/architecture/assistant-turn-spine.md), [Conversational directives](./docs/architecture/conversational-directives.md), and [Conversational routines](./docs/architecture/conversational-routines.md). To build a routine, see [Authoring routines](./docs/authoring-routines.md).

---

## Architecture

```
    Web app · REST API · TS SDK · MCP server · Website embed
      (browser, your code, Node app, Cursor/Claude/ChatGPT)
                               │ a turn enters the engine
                               ▼
   ═══════════════════ Conversation engine ═════════════════════

      Gather ──▶ Select ──▶ Dispatch ──▶ Compose ──▶ reply
                   ▲           │
                   │           ▼
      ┌───────────────┐   ┌─────────────────┐
      │ Directives    │   │     Skills      │
      │ matched rules │   │ retrieval.answer│
      │ that steer    │   │ documents.search│
      │ selection &   │   │ assistant.chat  │
      │ the reply     │   │ your skill …    │
      └───────▲───────┘   └─────────────────┘
              │
      ┌───────┴───────┐
      │ Routines      │  an active flow projects a
      │ stateful      │  directive each turn (and can
      │ multi-turn    │  drive a skill)
      │ flows         │
      └───────────────┘

   ═════════════════════════════════════════════════════════════
                               │ retrieval.answer reads
                               ▼
   Your content ──▶ ┌──────────────────────────────────┐
   chunk + embed    │       Postgres + pgvector        │
                    │   documents · chunks · vectors   │
                    └──────────────────────────────────┘
```

Every surface — the web app, REST API, SDK, MCP clients, and the website embed — hands its turn to the same conversation engine. Selection chooses which skills to run, steered by the directives that matched this turn; dispatch runs them; compose merges their outcomes with the steering into a reply. Skills are a set you extend: `retrieval.answer` reads the chunks and vectors a background worker has ingested into Postgres with `pgvector`, but it sits alongside document search, plain assistant chat, and any skill you register. Directives are standing rules that shape selection and the reply. A routine is a stateful, multi-turn flow that expresses itself each turn by projecting its current step into a directive, and can drive a skill as it advances. The headless retrieval, SDK, and MCP surfaces can also call retrieval directly when no assistant behavior is wanted.

Postgres is the system of record for everything, not just vectors: accounts, settings, conversations, and audit events live there too. Uploaded source files use the local filesystem in local development and GCS in cloud deployments. Ingestion runs in a background worker so uploads don't block the request path. The frontend, API, and worker all run in Docker Compose locally and on Cloud Run in production.

---

## Talking to Radioso

There are five ways to reach an agent: the web app, the REST API, the TypeScript SDK, an MCP client, and a website embed.

### Web app

1. Run `./run-dev.sh`.
2. Open `http://localhost:3000`.
3. Register or sign in.
4. If you skipped the provider key at startup, add one under Settings → Credentials. Chat and document processing both need a provider key.
5. Let Radioso seed the starter documents for the workspace.
6. Wait for document processing to finish.
7. Ask one of the suggested questions in chat.

Registration creates the account and default workspace, then sends a verification email. It does not create a session until the email is verified. Password reset and email verification are part of the open-source auth API, and sign-in requires a verified email address. Set `MAIL_DRIVER`, `MAIL_FROM_EMAIL`, `MAIL_FROM_NAME`, and `RESEND_MAIL_API_KEY` when you want hosted transactional email delivery; local development defaults to log output when no Resend key is configured.

Authenticated dashboard URLs are workspace-first. After sign-in, the app navigates under `/w/<workspace-public-route-key>/...`. Older `/account/<account-id>/...` dashboard links still work, but they redirect to the canonical workspace URL after the app restores the correct organization and workspace context.

### REST API

**Authentication and workspaces.** Register a user:

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

Each workspace payload includes both `id` and `publicRouteKey`. Use `id` for API calls that require a workspace identifier. Use `publicRouteKey` when you need to inspect or build the canonical dashboard URL. If a workspace token, public chat link, or Enterprise embed token is ever exposed, rotate it from the settings screen instead of relying on disable-and-re-enable toggles.

**Agents, assistant, and retrieval.** Use agents to configure agent identity, instructions, source scope, retrieval participation, per-skill settings, and public surface settings. Chat calls use the workspace default agent unless `agentId` is provided. Retrieval configuration lives on the agent `retrieval.answer` skill through `skillSettings["retrieval.answer"]`; omitted fields inherit system/model defaults. Multi-step **routines** are authored per agent under `/api/v1/agents/<agentId>/routines` — create or edit a draft, `POST .../validate`, then `POST .../publish`; see [Authoring routines](./docs/authoring-routines.md).

```bash
curl -sS \
  -H "Authorization: Bearer <workspace-token>" \
  http://localhost:8080/api/v1/agents
```

Use the assistant API for human-facing chat. Each turn runs through the [conversation engine](#the-conversation-engine), which interprets the message, selects the skills the turn needs — including the `retrieval.answer` skill when evidence is required — applies any matching directives or active routine, and composes the reply. The assistant API owns conversation history, source-channel context, assistant identity, direct social replies, persistence, and billing.

```bash
curl -sS \
  -H "Authorization: Bearer <workspace-token>" \
  -H 'Content-Type: application/json' \
  -d '{"message":"What does the FAQ say about refunds?","stream":false}' \
  http://localhost:8080/api/v1/assistant/chat
```

Use retrieval APIs when you want grounded search or answer generation over workspace context without assistant persona or chat routing. Retrieval-only calls use system defaults and still support per-call filters such as `metadataFilter`.

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

The read-only skills catalog lists the skills the conversation engine can select on a turn:

```bash
curl -sS \
  -H "Authorization: Bearer <workspace-token>" \
  http://localhost:8080/api/v1/skills
```

The catalog describes product-facing work and points to stable contracts. It does not add a generic skill execution endpoint. Skill entries may also declare UI display hints and their own outcome names. History and diagnostics expose those names with a normalized status so clients can filter by skill behavior without depending on retrieval-specific enums.

**History, settings, feedback, quality, and usage trends.** Assistant conversations are listed from `GET /api/v1/history/chat` and fetched from `GET /api/v1/history/chat/<conversation-id>`. `GET /api/v1/history` returns merged chat and document-search history. Shared workspace settings are read and merge-updated through `GET /api/v1/settings` and `PUT /api/v1/settings`, with assistant and channel settings. Ingestion settings stay under the settings API. Retrieval defaults are read-only at `GET /api/v1/settings/retrieval-defaults`; per-agent retrieval behavior is configured on the agent Skills tab. Signed-in account members can read aggregate account usage trends from `GET /api/v1/account/usage-trends`, bucketed by UTC day, week, or month and optionally filtered by workspace or agent.

Persisted assistant answers can receive thumbs up or thumbs down feedback in the dashboard, public chat, and website embed. Authenticated callers use `PUT /api/v1/answer-feedback/messages/<assistant-message-id>` and `DELETE /api/v1/answer-feedback/messages/<assistant-message-id>`. Public chat sessions use `PUT /api/v1/answer-feedback/public/chat/<token>/messages/<assistant-message-id>` and the matching `DELETE` route. A thumbs down request may include an optional `comment` up to 2000 characters.

Operators can review assistant-answer quality with `GET /api/v1/quality/turns`. Admins and owners can update an answer's triage state with `PUT /api/v1/quality/turns/<assistant-message-id>/triage`, using one of `open`, `acknowledged`, `resolved`, or `dismissed`.

Operators can also take over a conversation, reply as a named human, and resolve routine approval gates. The dashboard surfaces this under **Activity → Needs attention**, which lists pending approvals and human-owned conversations. See [Human takeover](./docs/human-takeover.md) for the ownership model, the approval queue (`GET /api/v1/decisions`) and resolve endpoint, and the tail endpoints that stream new messages to both operators and visitors.

**Debug output.** Assistant, retrieval, and search responses are lean by default. Add `includeDebug: true` to supported request bodies when an authenticated operator or integration needs diagnostic metadata. Debug responses place routing, retrieval summaries, activity traces, and full evidence under a `debug` field instead of mixing them into the normal user-facing payload. This is a breaking response-shape change for SDK and direct REST consumers that previously read diagnostics from top-level fields. Update TypeScript SDK clients to `@radioso/typescript-sdk` 0.2.0 or later and read diagnostic data from `response.debug`.

### TypeScript SDK

The SDK chat facade is for agent-backed assistant chat. Use the REST retrieval endpoints above for retrieval-only search or grounded answers when you do not want assistant behavior.

SDK 0.2.0 follows the lean response contract. Existing callers that read `route`, `activitySummary`, `activityTrace`, or retrieval `evidence` from top-level API responses should request debug output and read those values from `response.debug`.

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

Radioso exposes two MCP surfaces. The **agent converse surface** lets a client talk to one agent through its turn loop (`ask_agent`), request a grounded answer using that agent's retrieval settings, and read the agent's documents as resources. It uses a per-agent converse grant, minted by a workspace admin at `POST /api/v1/agents/{agentId}/mcp-converse-grants` and exchanged for a short-lived session. The **workspace document tools** (`search_documents`, `answer_grounded`, document read/write) are scoped to a whole workspace and use the workspace API token. The two surfaces do not share credentials.

Radioso supports MCP in two deployment shapes. Self-hosted operators can set `RADIOSO_MCP_ENABLED=true` with `RADIOSO_MCP_STANDALONE=false` and serve MCP from the backend at `/mcp`, using the workspace API token directly. Operators who need a separate public connector surface can keep backend MCP disabled and use the standalone `packages/radioso-mcp-server/` process with its token exchange flow.

Cursor can use either same-host merged mode or a local standalone server. Claude Desktop, ChatGPT deep-research, and other hosted remote MCP clients require a public HTTPS deployment plus compatible auth. A standard MCP OAuth front door for the converse surface is planned; until then, public connectors use a session token minted through the grant exchange.

### Website embed

Embed a Radioso chat widget on any website. One script tag, pasted on any page of an approved origin, opens a Radioso-hosted chat iframe — no backend work required on the host site, and origin policy stays under your control. The widget, its theming, and origin approval are part of the open-source build; Enterprise Edition adds human-contact routing on top.

The channels settings screen shows whether public chat and website embed launch credentials are active or revoked, plus when each credential was last used. Revoking a public link or embed credential stops new launches without issuing a replacement. Rotate the credential when you want to issue a new link or install code.

---

## Operations

### LLM providers and model selection

Workspaces can supply their own provider API keys and pick a model per capability without restarting the backend. Keys are encrypted with `CONNECTOR_ENCRYPTION_KEY` (the same key that protects connector secrets; the bootstrap command generates one when missing) and never round-tripped to clients.

List configured providers, store a key, or remove one:

```bash
curl -sS \
  -H "Authorization: Bearer <workspace-token>" \
  http://localhost:8080/api/v1/settings/credentials

curl -sS -X PUT \
  -H "Authorization: Bearer <workspace-token>" \
  -H 'Content-Type: application/json' \
  -d '{"apiKey":"sk-..."}' \
  http://localhost:8080/api/v1/settings/credentials/claude

curl -sS -X DELETE \
  -H "Authorization: Bearer <workspace-token>" \
  http://localhost:8080/api/v1/settings/credentials/claude
```

Read or update the per-workspace chat / rewrite / rerank model preference. A `null` value clears that capability and falls back to the env default:

```bash
curl -sS \
  -H "Authorization: Bearer <workspace-token>" \
  http://localhost:8080/api/v1/settings/llm-models

curl -sS -X PUT \
  -H "Authorization: Bearer <workspace-token>" \
  -H 'Content-Type: application/json' \
  -d '{"chat":{"provider":"claude","model":"claude-sonnet-4-5"},"rerank":null}' \
  http://localhost:8080/api/v1/settings/llm-models
```

Agents can override the chat model for a specific persona via `chatModelOverride` on `PUT /api/v1/agents/<agentId>`. Resolution order at chat time is agent override → workspace preference → env default. API keys come from the workspace credential first, then fall back to the matching environment variable (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`). The `openai-compatible` provider also requires `OPENAI_COMPATIBLE_BASE_URL` — a workspace selecting it without a base URL fails with a clear error instead of silently calling the default OpenAI endpoint.

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

### Website crawler

Radioso exposes an OSS website crawler provider port at `POST /api/v1/document/crawl`. The route accepts a website URL, calls the bundled `radioso-crawler` provider by default, and publishes returned pages through the normal document ingestion pipeline.

Application composition can register a different crawler provider for custom deployments. Crawl limits are controlled with `WEBSITE_CRAWLER_MAX_LIMIT` (default 1,000 pages), and crawl requests can also set simple URL allow and deny substrings. Outbound requests identify as `RadiosoCrawler/1.0` by default; set `WEBSITE_CRAWLER_USER_AGENT` when a deployment needs a custom allowlisted crawler identity or contact URL. Pages exceeding 500,000 characters are skipped during ingestion. Website sources can be re-crawled, paused, resumed, or deleted through the source management API; see `docs/website-crawler.md` for details.

The bundled crawler does not rotate user agents or proxies to bypass site blocks. Responses with `401`, `403`, or `429` are recorded as failed pages instead of being ingested as content.

`GET /api/v1/document/crawl/jobs` lists recent crawl jobs for the current workspace with their status, requested URL, page count, and last error. The dashboard Knowledge Base page uses it to display a status banner for in-flight and recently completed crawls. See `docs/website-crawler.md` for the full request and response shape.

Website crawls run in a separate process from document chunking and embeddings. Locally, `docker-compose.yml` and `docker-compose.dev.yml` add a `backend-crawler-worker` service alongside `backend-worker` (running `pnpm run start:crawler-worker` or `dev:crawler-worker`). On Cloud Run, Terraform provisions a dedicated `radioso-<env>-crawler-worker` service and wires its run.app URL into the backend's `WORKER_TASKS_CRAWL_SERVICE_URL` automatically. No manual override is needed. When the env var is unset, such as in self-hosted single-process deployments, crawls reuse `WORKER_TASKS_SERVICE_URL`. See `docs/website-crawler.md` for the full deployment topology.

Set `WEBSITE_CRAWLER_ENABLED=false` to disable the crawler entirely. The API hides the crawl routes (404), the dashboard hides the "Crawl Website" button, and the crawler worker entrypoints exit on startup so the container can be removed.

### Reverse proxy client IPs

Radioso keeps Express `trust proxy` disabled by default. Set `TRUST_PROXY_HOPS` only when the backend runs behind trusted reverse proxies and rate limits must use the real client IP from `X-Forwarded-For`.

`TRUST_PROXY_HOPS=0` is the secure default for self-hosted deployments without a proxy. For GCP Cloud Run behind the frontend API proxy, the value is typically `1` or `2` depending on the exact topology. Set the exact number of trusted hops for your deployment.

### Public chat rate limits

Public chat and website embed rate limits are configured by operators, not workspace users. The optional `PUBLIC_CHAT_RATE_LIMIT_WINDOW_MS`, `PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS`, and `PUBLIC_CHAT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS` environment variables tune those limits; backend defaults apply when they are unset.

Older workspace-level `anonymousRateLimit` and `messagesPerMinute` settings are ignored. Operators with custom public-chat limits should set the environment variables above.

### Authenticated LLM request limits

Authenticated assistant chat and retrieval answer/search routes share a durable rate limit because they can trigger model or retrieval work. Operators can tune it with `EXPENSIVE_AUTHENTICATED_RATE_LIMIT_WINDOW_MS` and `EXPENSIVE_AUTHENTICATED_RATE_LIMIT_MAX_ATTEMPTS`. The default is 60 requests per 60 seconds.

The limit is scoped by account and workspace for browser sessions. Workspace API tokens get separate token-specific buckets within the same account and workspace.

---

## Docs

- [MCP client setup](./docs/mcp-client-setup.md)
- [TypeScript SDK getting started](./docs/typescript-sdk-getting-started.md)
- [TypeScript SDK basic usage](./docs/typescript-sdk-basic-usage.md)
- [Assistant execution model](./docs/assistant-execution-model.md)
- [Human takeover](./docs/human-takeover.md)
- [Assistant turn spine](./docs/architecture/assistant-turn-spine.md)
- [Conversational directives](./docs/architecture/conversational-directives.md)
- [Observability](./docs/oss-saas-observability.md)

Full configuration reference, API docs, retrieval tuning guide, and deployment documentation: [docs/README.md](./docs/README.md).

---

## Contributing

```
backend/         Express API and background document worker
frontend/        Next.js application
typescript-sdk/  First-party TypeScript SDK
packages/        Shared local packages (conversation engine, MCP server, parser, contracts)
infra/           Docker Compose and Terraform
docs/            Product and SDK guides
```

Run `./run-dev.sh` to get a full local stack. Detailed setup and follow-on guides are indexed in [docs/README.md](./docs/README.md).

---

## License

Radioso is dual-licensed:

- The open-source edition is licensed under the [Apache License, Version 2.0](./LICENSE).
- The files under [`ee/`](./ee) are Radioso Enterprise Edition, commercial source-available software governed by [`ee/LICENSE`](./ee/LICENSE), and are **not** covered by Apache 2.0.
  We are happy for everyone to be able to run Radioso for their business and personal purposes. In ee/ we store features and setups required for us to run Radioso on the cloud, and using them requires a commercial license. Contact us for inquiries!

See [NOTICE](./NOTICE) for the attribution and the Enterprise Edition.
