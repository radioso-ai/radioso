# @radioso/n8n-nodes-radioso

The Radioso community nodes for [n8n](https://n8n.io). A workflow can ask a Radioso agent a question, search your knowledge, add a document, or read a conversation, and the **Radioso** node doubles as a tool for n8n's AI Agent node. Two trigger nodes start a workflow when something happens in Radioso: a visitor starts a conversation, leaves contact details, is handed to a person, finishes a routine, or is waiting on a decision.

## Install

On a self-hosted n8n, open **Settings → Community Nodes → Install** and enter `@radioso/n8n-nodes-radioso`.

## Credentials

Create a **Radioso API** credential:

- **Instance**: EU Cloud (`https://api.radioso.ai`), US Cloud (`https://api-us.radioso.ai`), or Self-Hosted with the `https://` origin of your backend API, which often ends in `/backend`, for example `https://radioso.example.com/backend`.
- **Service Account Token**: a `radioso_svc_v1_...` token from **Settings → API access** in Radioso. The `member` role covers every operation.

n8n tests the credential with `GET /api/v1/workspace/summary`. A self-hosted URL must start with `https://`; plain `http://` is accepted only for `localhost`, `127.0.0.0/8`, `::1`, private IPv4 addresses (10/8, 172.16/12, 192.168/16) and single-word host names such as a Docker service name, so the token never crosses the public internet unencrypted. A pasted trailing `/api/v1` is dropped.

## Operations

| Resource | Operation | Radioso route |
|---|---|---|
| Agent | Ask | `POST /api/v1/assistant/chat` |
| Knowledge | Search | `POST /api/v1/retrieval/search` |
| Knowledge | Answer | `POST /api/v1/retrieval/answer` |
| Document | Add or Replace | `POST /api/v1/document` |
| Conversation | Get | `GET /api/v1/history/chat/{conversationId}` |

### Ask an agent

Pick an agent from the list, or leave it empty to use the workspace's default agent. To continue a conversation, set **Conversation ID** from an earlier reply; the conversation keeps its agent, so the node sends none then.

The output carries `answer`, `citations`, `conversationId`, plus two fields the node adds:

- `conversationOwner` is `ai_owned` or `human_owned`.
- `replySuppressed` is `true` when a teammate owns the conversation and the agent did not answer. `answer` is then the waiting message shown to the visitor and `assistantMessageId` is empty. The turn that hands a conversation to a teammate is `human_owned` with `replySuppressed: false` and a real answer. Check `replySuppressed` before you post `answer` anywhere.

**Retry On Fail** sends the message again. A retried first message opens a second conversation, so leave it off or continue with a Conversation ID.

### Add or replace a document

Sends a title and text, with optional metadata and an **External Document ID**. Sending an External Document ID that already exists replaces that document, so a workflow can keep one document in sync with a record; unchanged content comes back ready at once (`processing: "complete"`). Otherwise processing is asynchronous: the node returns as soon as Radioso accepts the document (`processing: "asynchronous"`), and it is searchable when its status is ready.

### Get a conversation

Returns the transcript without the visitor's profile, request context (including IP address), page URLs or debug data: `conversationId`, `agentId`, `agentName`, `sourceChannel`, `title`, `createdAt`, `updatedAt`, `messageCount`, `conversationOwner`, `messages` (each `{source, content, createdAt}`, system rows left out), a `transcript` of `source: content` lines, and `transcriptIsPartial`, which is `true` when older messages are not included. The node reads the latest 100 messages unless you set **Message Limit** and **Message Offset**. Message text is the visitor's own words and can contain personal data they typed.

### Not included

Replying as an operator and resolving decisions need a signed-in dashboard session in Radioso, so a service-account token can't call them.

### Use as an AI Agent tool

The Radioso node is marked usable as a tool, and current n8n versions list it on the AI Agent node's **Tool** input without a setting. Older 1.x versions need `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true` on self-hosted n8n. Because Get a conversation returns message text, only attach it to an agent whose model you are comfortable seeing that text.

## Start a workflow from Radioso events

Both trigger nodes use the same **Events** list and emit one item per event: `id`, `type`, `version`, `occurredAt`, `workspaceId` and `data`. The `data` of each type is described in the [workspace event log](https://docs.radioso.ai/api/workspace-event-log) reference. Choose at least one of Conversation Started, Contact Request Created, Handoff Requested, Routine Completed and Decision Pending. Decision Pending only notifies: a teammate decides in the Radioso Inbox, because a service-account token can't resolve a decision.

A service account's role needs `workspace.event_subscriptions.manage` (the `member` role holds it) plus read access to each chosen type. Conversation events need history access, and Decision Pending also needs the takeover permission. Radioso answers `403` with `event_type_not_permitted` otherwise.

### Radioso Trigger

The webhook trigger. When you activate the workflow, the node subscribes in Radioso with its own webhook URL, labelled `n8n`, and keeps the subscription id and signing secret in the workflow's static data. Radioso pushes each event to n8n as it happens, signed with `X-Radioso-Signature` (HMAC-SHA256 over `{timestamp}.{raw body}`). The node checks the signature against the raw request body, refuses a timestamp more than five minutes away, and answers `401` without starting the workflow when either check fails. Deactivating the workflow deletes the subscription.

- n8n needs a public `https://` address, so set `WEBHOOK_URL` on a self-hosted n8n. Radioso refuses a local or plain-http target with `invalid_target_url`.
- A new subscription starts at the newest event and does not backfill. **Listen for Test Event** works against n8n's test webhook URL; it subscribes for the test and removes the subscription when the test ends.
- Delivery is at-least-once. If your workflow must not run twice for one event, de-duplicate on `id`.
- Change the chosen events and re-activate to replace the subscription.

Use **one service account per workflow**. A subscription belongs to the credential that created it, so revoking that service account's token disables every subscription it made. A shared token takes every workflow down together.

A workspace holds at most 25 subscriptions. Radioso disables a subscription whose deliveries fail for 24 hours; re-activating the workflow subscribes again.

### Radioso Poll Trigger

The polling alternative, for an n8n instance Radioso can't reach: behind a firewall, on a private network, or without a public HTTPS address. It reads the event log on the schedule you set and needs no subscription, so it uses a token with `workspace.events.read` and the read access for each type.

- The first run records where the log ends and emits nothing, so the workflow does not start on old events. **Fetch Test Event** emits the newest three events as sample data.
- Each later run emits the events since the saved position, oldest first, and skips any id it has already emitted.
- Radioso keeps events for 30 days. When the saved position has expired, or Radioso no longer accepts it, the node starts over like a first run: it records where the log ends and emits nothing, so events from the gap are not delivered.
- Changing the chosen events, or pointing the credential at another instance, starts over the same way.

Polling adds delay up to the poll interval; the webhook trigger is immediate.

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
cd packages/n8n-nodes-radioso
npm ci                    # installs on its own, outside the repo's pnpm workspace
npm run lint              # n8n's node linter
npm test
npm run build
npm run dev               # a local n8n with the node loaded
```

Releases publish from GitHub Actions with an npm provenance statement (`.github/workflows/publish-n8n-node.yml`), which n8n requires for verified community nodes.

## License

MIT. See `LICENSE`. The rest of the Radioso repository is Apache-2.0; this directory is MIT because n8n requires it of verified community nodes.
