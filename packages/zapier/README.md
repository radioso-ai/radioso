# @radioso/zapier

The Radioso integration for Zapier, built with the Zapier Platform CLI (`zapier-platform-core` 19.3.0, Node 22 runtime, ES modules). It calls the bearer API with a service-account token and holds no Radioso code: every request and response shape comes from `typescript-sdk/openapi/radioso.yaml`, and every permission from `backend/src/app/http/apiPrincipalRoutePolicy.ts`.

## What it contains

| Piece | Type | API route | Permission |
|---|---|---|---|
| Authentication | custom: instance URL, token, optional workspace name | `GET /api/v1/workspace/summary` | `workspace.summary.read` |
| Ask an Agent | action | `POST /api/v1/assistant/chat` | `workspace.chat.use` |
| Search Knowledge | action | `POST /api/v1/retrieval/search` | `workspace.retrieval.query` |
| Add a Document | action | `POST /api/v1/document` (202, processed in the background) | `workspace.documents.manage` |
| Find Conversation | search | `GET /api/v1/history/chat/{id}` | `workspace.history.read` |
| Agent | hidden trigger feeding the agent dropdown | `GET /api/v1/agents` | `workspace.agents.read` |

The `member` role holds all of these.

## Behavior worth knowing

- **Instance URL.** The URL the API answers on, over `https`: `https://api.radioso.ai`, `https://api-us.radioso.ai`, or a self-hosted origin, which often serves the API at its app address plus `/backend` (`https://app.example.com/backend`). A pasted `/api/v1` suffix and trailing slashes are dropped. The connection label is the optional workspace name, else the instance host, because the workspace summary does not return a name.
- **Ask an Agent** uses `/assistant/chat` because `/agents/{agentId}/chat` accepts only an agent-channel credential. A conversation belongs to the agent that started it, so the step sends `agentId` only for a new conversation. A service-account token can continue any conversation in its workspace, so the Conversation ID to map is the one an earlier Ask an Agent step returned.
- **Timeouts.** Zapier stops an action after about 30 seconds. A first turn that times out returns no Conversation ID to look up, and Zapier's Autoreplay can send the same message again.
- **Handed-off conversations.** While a teammate owns the conversation, the API answers with a waiting message and an empty `assistantMessageId`. The step returns `reply_suppressed: true` and `id` falls back to the conversation id; a Zap should Filter on `reply_suppressed`.
- **Add a Document** sends text. Sending an External ID that already exists replaces that document, and unchanged content returns `ready` at once; a new document is processed in the background.
- **Find Conversation** returns message text only, labelled by who wrote it (`customer`, `ai_agent`, `human_agent`), without system rows. The visitor profile and request context (which holds an IP address) are not copied. An id that is not a UUID finds nothing without calling the API.
- Replying as an operator, taking over, handing back, and resolving a decision (`/conversations/{id}/reply|takeover|handback`, `/agents/{agentId}/decisions/{handle}/resolve`) are session-only routes, so a service-account token cannot call them and the app has no action for them.

## Layout

```
index.js              app definition
authentication.js     custom auth, test call, connection label
lib/client.js         instance URL handling, bearer header, API error mapping
lib/fields.js         the shared agent dropdown field
triggers/agent.js     hidden trigger behind the dropdown
creates/              Ask an Agent, Search Knowledge, Add a Document
searches/             Find Conversation
test/app.test.js      nock-backed tests, no live calls
```

Output keys are snake_case and flat so Zapier's field mapper lists them.

## Commands

Run these from this directory. The Zapier CLI is not a dependency of the workspace (its dependency tree carries advisories the rest of the repo does not); the scripts fetch the pinned version with `pnpm dlx`.

```bash
pnpm test           # local schema validation (no Zapier servers), then the vitest suite
pnpm run validate   # the full zapier-platform validate; its style checks call Zapier's servers
pnpm run build      # zapier-platform build; writes build/build.zip and build/source.zip
```

CI runs `pnpm test` only. `validate` without `--without-style` and `build` call Zapier's servers, so the owner runs them before a push.

## Building inside the pnpm workspace

`zapier-platform build` copies the project to a temporary directory and installs `dependencies` there from the registry, without the repo lockfile. The app must not depend on another workspace package (`workspace:*` cannot resolve outside the workspace). Its only runtime dependency is `zapier-platform-core`, pinned to an exact version, though its own dependencies resolve at build time. The package stays out of the backend and frontend images: their installs are filtered to the packages they need.

Zapier loads an ES module app through `exports`, so `package.json` declares `"exports": "./index.js"` rather than `main`.

## Publishing

Registering and pushing are owner actions and are not part of CI.

1. Create a Zapier developer account and `zapier-platform login`.
2. `zapier-platform register "Radioso"` from this directory. It writes `.zapierapprc`, which carries the app id.
3. `zapier-platform validate` and `zapier-platform build`, then `zapier-platform push` to upload the version in `package.json`.
4. Invite testers with `zapier-platform users:add <email>`, or share the invite link from `zapier-platform users:links`. Zapier's public listing review is a separate submission with its own requirements (integration checks, a support contact, and a working test account).
