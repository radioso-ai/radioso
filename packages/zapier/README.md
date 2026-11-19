# @radioso/zapier

The Radioso integration for Zapier, built with the Zapier Platform CLI (`zapier-platform-core` 19.3.0, Node 22 runtime). It calls the bearer API with a service-account token and holds no Radioso code: every request and response shape comes from `typescript-sdk/openapi/radioso.yaml`, and every permission from `backend/src/app/http/apiPrincipalRoutePolicy.ts`.

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

Ask an Agent uses `/assistant/chat` because `/agents/{agentId}/chat` accepts only an agent-channel credential. Replying as an operator, taking over, handing back, and resolving a decision (`/conversations/{id}/reply|takeover|handback`, `/agents/{agentId}/decisions/{handle}/resolve`) are session-only routes, so a service-account token cannot call them and the app has no action for them.

The workspace summary does not return the workspace name, so the connection label is the optional "Workspace name" field, or the instance host.

## Layout

```
index.js              app definition
authentication.js     custom auth, test call, connection label
lib/client.js         instance URL handling, bearer header, API error mapping
lib/fields.js         the shared agent dropdown field
triggers/agent.js     hidden trigger behind the dropdown
creates/              Ask an Agent, Search Knowledge, Add a Document
searches/             Find Conversation
test/app.test.mjs     nock-backed tests, no live calls
```

Output keys are snake_case and flat so Zapier's field mapper lists them. The Find Conversation transcript carries message text only; the visitor profile and request context (which holds an IP address) are not copied.

## Commands

Run these from this directory.

```bash
pnpm run validate   # zapier-platform validate: schema and integration checks
pnpm test           # validate, then the vitest suite
pnpm run build      # zapier-platform build: writes build/build.zip and build/source.zip
```

## Building inside the pnpm workspace

`zapier-platform build` copies the project to a temporary directory and installs `dependencies` there, so the app must not depend on another workspace package (`workspace:*` cannot resolve outside the workspace). Its only runtime dependency is `zapier-platform-core`, pinned to the exact version. The package also stays out of the backend and frontend images: their installs are filtered to the packages they need.

The root `pnpm.overrides` pins `file-type` to 21.x for security. The Zapier CLI unpacks `build.zip` through `decompress-unzip`, which needs the 3.x API, so the override `decompress-unzip>file-type` scopes that one dependency back to 3.x. Without it `zapier-platform build` fails at "Testing build" with `fileType is not a function`.

## Publishing

Registering and pushing are owner actions and are not part of CI.

1. Create a Zapier developer account and `zapier-platform login`.
2. `zapier-platform register "Radioso"` from this directory. It writes `.zapierapprc`, which carries the app id.
3. `zapier-platform push` uploads the version in `package.json`.
4. Invite testers with `zapier-platform users:add <email>`, or share the invite link from `zapier-platform users:links`. Zapier's public listing review is a separate submission with its own requirements (integration checks, a support contact, and a working test account).
