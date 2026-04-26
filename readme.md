# <img src="./frontend/public/radioso-logo.png" alt="Radioso logo" width="44" align="center" /> Radioso

**The opinionated context platform for delightful assistants.**

You can wire up LangChain and build a rocketship. You can get a PhD in dragging nodes around a low-code agent canvas. 
Or you can run Radioso, upload your documents, and have an assistant that knows what it's talking about — self-hosted, multi-provider, API-first, today. That is why we built Radioso. 

## Quick Start

**Prerequisites:** Node.js 22+, Docker Desktop, and at least one of `OPENAI_API_KEY`, `GEMINI_API_KEY`, or `ANTHROPIC_API_KEY`.

```bash
./run-dev.sh
```

The bootstrap prompts for your AI provider credentials, generates secrets, and starts the full stack. Register, upload a document, ask a question. Working grounded assistant in under five minutes.

In the Docker development stack, frontend and backend source changes are bind-mounted into the containers. TypeScript backend changes restart automatically, and backend prompt markdown under `backend/prompts/` is re-read on each request in development without a container restart.

| Surface | URL |
|---|---|
| App | http://localhost:3000 |
| API | http://localhost:8080 |
| Embed test harness | http://127.0.0.1:4321 after running `node scripts/serve-embed-test-site.mjs` |

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

New accounts must verify their email before the first sign-in completes, except in the default `./run-dev.sh` local setup where `AUTH_SKIP_EMAIL_VERIFICATION=true` is written into `backend/.env` for faster local iteration. Local runs also default to `MAIL_DRIVER=log`, so verification and password reset links are written to backend logs unless you point the app at a real SMTP server.

Authenticated dashboard URLs are workspace-first. After sign-in, the app navigates under `/w/<workspace-public-route-key>/...`. Older `/account/<account-id>/...` dashboard links still work, but they redirect to the canonical workspace URL after the app restores the correct organization and workspace context.

### API auth flow

Register a user:

```bash
curl -sS \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"verysecurepassword"}' \
  http://localhost:8080/api/v1/auth/register
```

That response includes `workspaceId`, `workspacePublicRouteKey`, and `requiresEmailVerification`. Verify the email first when required, then log in to save the session cookie:

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

Use retrieval APIs when you want grounded RAG capabilities without assistant persona or chat routing.

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

### TypeScript SDK

The SDK chat facade is for assistant chat. Use the REST retrieval endpoints above for retrieval-only search or grounded answers when you do not want assistant behavior.

```ts
import { createRadiosoClient } from "@radioso/typescript-sdk";

const client = createRadiosoClient({
  baseUrl: "http://localhost:8080",
  apiToken: process.env.RADIOSO_API_TOKEN!,
});

await client.documents.create({ title: "Support FAQ", content: "..." });

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
