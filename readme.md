# <img src="./frontend/public/radioso-logo.png" alt="Radioso logo" width="44" align="center" /> Radioso

**The opinionated context platform for rapid assistant integrations.**

You can wire up LangChain. You can drag nodes around a low-code agent canvas. Or you can run Radioso, upload your documents, and have an assistant that actually knows what it's talking about — self-hosted, multi-provider, API-first, today.

## Quick Start

**Prerequisites:** Node.js 22+, Docker Desktop, and at least one of `OPENAI_API_KEY`, `GEMINI_API_KEY`, or `ANTHROPIC_API_KEY`.

```bash
./run-dev.sh
```

The bootstrap prompts for your AI provider credentials, generates secrets, and starts the full stack. Register, upload a document, ask a question. Working grounded assistant in under five minutes.

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

### TypeScript SDK

```ts
import { createRadiosoClient } from "@radioso/typescript-sdk";

const client = createRadiosoClient({
  baseUrl: "http://localhost:8080",
  apiToken: process.env.RADIOSO_API_TOKEN!,
});

await client.documents.create({ title: "Support FAQ", content: "..." });

const response = await client.chat.create({
  query: "What does the FAQ say about refunds?",
  stream: false,
});

for await (const event of client.chat.stream({ query: "Summarize the FAQ" })) {
  if (event.type === "chunk") process.stdout.write(event.textDelta);
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
