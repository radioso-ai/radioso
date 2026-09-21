---
title: "Slack Channel"
description: "Connect a Radioso workspace and its agents to Slack direct messages, channel threads, human escalation posts, and operator callbacks."
last_updated: 2026-09-21
---

# Slack Channel

The Slack channel lets people talk to Radioso agents from Slack. One Slack
workspace connects to one Radioso workspace — the one that installed the Slack
app. That workspace's default agent answers direct messages and channels that
do not have a specific agent. Individual Slack channels can be assigned to specific agents.

The same Slack connection can also post an escalation to a human Slack channel
when the agent has no grounded answer.

Slack is only a channel. It is not a document source. Radioso does not read
Slack history, does not call Slack search, and does not add Slack messages to
the knowledge base.

## What It Does

- Direct messages to the Slack bot are routed to the default Radioso agent.
- `@mention` events in Slack channels are answered in the originating thread.
  A channel-specific binding wins when one exists. Otherwise, Radioso uses the
  default agent.
- Once the agent has answered in a thread, it keeps following that thread.
  Replies in it reach the agent without another `@mention`, so a follow-up
  question is just the next message. The agent stays out of threads it was
  never brought into.
- A channel binding also carries a **Responds to** setting. With
  `@mentions only`, the default, the agent speaks when tagged and inside
  threads it already answers in. With `Every message`, it also answers every
  top-level message in that channel, each in a new thread under the message.
  The default agent binding is always `@mentions only`, so an agent never
  starts answering unprompted in a channel nobody configured.
- While the agent works on a message, Radioso adds an `eyes` reaction to it. Once
  the reply is posted, the `eyes` reaction is replaced with a check mark, or with
  an `x` if the reply could not be delivered.
- Answers are posted as formatted Slack messages, so bold text, lists, and
  links in the agent's answer render the way they do in the web chat.
- Radioso appears in Slack's agent pane, the **Agents & AI Apps** entry next to
  the message list. Each chat started there is a session: a thread in the
  app's direct message that maps to one Radioso conversation, shows a working
  indicator while the agent answers, and takes its title from the person's
  first message. The Messages tab offers the agent's greeting chips as
  suggested prompts.
- Each agent-pane session (every direct message thread) and each channel
  thread maps to one Radioso conversation.
- When the turn outcome is `no_context`, gap escalation is enabled, and an
  escalation channel is configured, Radioso posts a human follow-up message to
  that channel. A turn the agent declined as `out_of_scope` never escalates:
  the agent handled it as configured, so there is nothing for a person to pick
  up.
- Routines can also use allowlisted Slack skills to post deliberate handoff or
  lead messages.
- Approval gates, handoffs, and unanswered questions arrive as interactive
  messages. Operators approve, deny, take over, reply to the customer, or hand
  back from Slack.
- A sibling Radioso workspace in the same organization can share the same Slack
  installation. It does not create a second bot identity for the same Slack
  workspace.

Answers still come from the agent's curated Radioso knowledge. If the curated
knowledge does not cover the question, the agent must decline safely or
escalate. The Slack channel does not make uncurated Slack content available to
the answer.

## Radioso in Slack's Agent Pane

Slack lists agent apps in a pane of their own, reachable from the sidebar and
the top of any channel. Radioso registers there, so people can open a chat
with the agent without finding its direct message first.

Every direct message to the app is a session. Slack keeps each session as a
thread in the app's direct message, anchored on the first message, and Radioso
keeps one conversation per session, the same way it keeps one per channel
thread. Replies go into the session thread, and an operator reply from the
Inbox lands there too. Starting a new chat in the pane starts a new session;
writing inside an existing one continues it.

While the agent works on a session message, the pane shows Slack's working
indicator instead of the `eyes` reaction, and clears it once the reply is
posted or the turn fails; a message replaced by a newer one in the same session
leaves the indicator to that newer message. After the
first answer, the session takes its title from the person's first message,
collapsed to one line and cut at 60 characters, so the sidebar shows what each
session was about in the person's own words.

The Messages tab shows up to four suggested prompts. They are the greeting
chips authored on the default agent's published revision, the same chips the
website widget shows under the greeting, resolved in the agent's default
language. An agent whose greeting is automatic, switched off, or has no chips
offers no prompts. Prompts refresh each time someone opens the Messages tab;
nothing is started or recorded by that visit.

Sessions, the working indicator, and titles work with the `chat:write` scope
every install has. Suggested prompts need the `assistant:write` scope and the
`app_home_opened` event. An install that predates them shows `needs_reauth` in
the install status and logs `missing_scope` when someone opens the Messages
tab; sessions keep working in full, only the prompts stay empty until you
reinstall or re-consent the app.

## Operator Actions in Slack

When the agent needs a person, Radioso posts an interactive message to the
operator channel. Operators act on it from Slack, without opening the dashboard.

Three kinds of events arrive in the operator channel:

- An approval gate posts the decision with one button per option. The options
  come from the routine, not a fixed approve or deny pair.
- A handoff, and an unanswered question (a gap), each post a card with a
  **Take over** button.

From these messages an operator can:

- Approve or deny a decision. The routine resumes with the chosen option.
- Take over a conversation. The agent stops answering it.
- Talk to the customer. A short Slack form opens, and the reply goes to the
  customer where the conversation started: back in their Slack direct message,
  or in the website chat.
- Hand the conversation back to the agent.

Only Radioso workspace members can act. Radioso matches the Slack user to a
member by email, so the Slack user's email must match their Radioso account. A
Slack user who is not a member, or who lacks the takeover permission, gets a
private message and the action does not run.

Each action is resolved by the same Radioso services the dashboard uses, and is
recorded with the operator who performed it. A button that is already out of
date, because someone resolved it first, is rejected without changing the
result.

These actions need the app's interactivity and user lookup scopes. If the Slack
app was installed before these were added, reinstall or re-consent it.

## Slack in the Inbox

A Slack conversation shows its real Slack context in the Inbox. The
conversation list and the reading pane show the Slack workspace, whether it is
a direct message or a channel, the thread, and the Slack user. A Slack
conversation is not shown as a plain authenticated chat.

## Cloud Setup

On Radioso Cloud, Radioso owns the Slack app. Workspace admins do not enter
Slack tokens or app secrets.

1. Open the agent Slack channel settings.
2. Select **Add to Slack**.
3. Approve the Slack OAuth install.
4. Return to Radioso and confirm the default agent.
5. Optionally add channel-specific agent bindings, and choose per channel
   whether the agent responds to `@mentions only` or to `Every message`.
6. Optionally set an escalation channel, such as `#support`.

The setup uses these API surfaces:

- `POST /api/v1/workspaces/{workspaceId}/slack/install/start`
- `GET /api/v1/workspaces/{workspaceId}/slack/install/status`
- `GET /api/v1/workspaces/{workspaceId}/slack/binding`
- `GET /api/v1/workspaces/{workspaceId}/slack/bindings`
- `PUT /api/v1/workspaces/{workspaceId}/slack/binding`
- `DELETE /api/v1/workspaces/{workspaceId}/slack/binding?channelId={channelId}`

A binding carries `channelId`, `answeringAgentId`, `escalationChannelId`,
`gapEscalationEnabled`, and `respondMode`. `channelId` is the channel ID shown
in Slack's channel details (it starts with `C`), not the `#name`. Slack
delivers events by ID, so a
binding saved under `#support` matches nothing: mentions there fall back to the
default agent and an `every_message` setting on it never fires. `respondMode`
is `mention` or `every_message`; omit it on `PUT` to keep the stored value.
Setting `every_message` on the default binding (`channelId` null or omitted)
is rejected with `400`, because that binding stands in for every channel
without its own binding.

## Self-Host Setup

Self-hosted deployments use the same OAuth flow. The difference is that the
operator supplies their own Slack app secrets through environment variables.

1. Set `APP_BASE_URL` to the public HTTPS URL where users open the Radioso
   dashboard.
2. Open the agent Slack channel settings and expand **Self-host setup**.
3. Copy the generated Slack app manifest.
4. In Slack, create an app from that manifest.
5. Set these environment variables from the Slack app:
   - `SLACK_OAUTH_CLIENT_ID`
   - `SLACK_OAUTH_CLIENT_SECRET`
   - `SLACK_SIGNING_SECRET`
6. Restart the backend.
7. Use **Add to Slack** in the Radioso UI.

Slack is available only when all three Slack environment variables are set.
If one is missing, Radioso does not start Slack OAuth install and the UI shows
which variable the operator still needs to configure.

### Split-host deployments

`APP_BASE_URL` is the dashboard origin. Radioso uses it for browser redirects,
such as the page shown after a Slack install completes.

Slack reaches the backend directly for the OAuth callback and the Events API.
When the backend runs on a different host than the dashboard, set
`CONNECTOR_PUBLIC_BASE_URL` to the backend's public HTTPS origin. The manifest
and the OAuth callback then use this host. A typical setup is a dashboard at
`https://app.example.com` and an API at `https://api.example.com`.

When `CONNECTOR_PUBLIC_BASE_URL` is not set, Radioso falls back to
`APP_BASE_URL`, which is correct when one host serves both.

The manifest is available from:

`GET /api/v1/workspaces/{workspaceId}/slack/manifest`

It fills, using `CONNECTOR_PUBLIC_BASE_URL` when set and otherwise `APP_BASE_URL`:

- `oauth_config.redirect_urls` with
  `{backend host}/api/v1/oauth/callback/slack`
- `settings.event_subscriptions.request_url` with
  `{backend host}/api/connectors/slack/events`
- `settings.interactivity.request_url` with
  `{backend host}/api/connectors/slack/interactivity`
- bot scopes for mentions, chat posting, message reactions, direct messages,
  channel message history (`channels:history`, `groups:history`), the agent
  pane (`assistant:write`), and Slack user lookup (`users:read`,
  `users:read.email`)
- bot events for mentions, direct messages, public and private channel
  messages, and opening the app's Home (`app_mention`, `message.im`,
  `message.channels`, `message.groups`, `app_home_opened`)
- `features.agent_view` with a short description of what the agent does, which
  lists the app in the agent pane, and `features.app_home` with the Messages
  tab enabled. Suggested prompts are set per workspace at runtime, so the
  manifest carries none.

The channel message events are what let the agent follow a thread without a
re-tag and answer every message in a channel configured that way. Radioso only
acts on those events for threads it already answers in or channels bound with
`Every message`. For everything else it keeps the Slack event id alone, with
no message text, so a redelivery of the same event is recognised, and discards
that id after the retention window described under Data Flow.

If an existing Slack app was installed before some of these scopes or events
were part of the manifest, the install status shows `needs_reauth` and the
agent keeps answering mentions and direct messages only. Update the app's event
subscriptions from the current manifest, then reinstall or re-consent the app
so Slack grants the new scopes.

The backend must be reachable by Slack at a public HTTPS URL. If Slack cannot
reach the callback, event, or interactivity URL, OAuth install and inbound messages cannot
complete.

## Data Flow

1. Slack sends OAuth callbacks to Radioso after app install.
2. Radioso stores the bot token encrypted and keyed by Slack `team_id` for the
   Radioso organization.
3. Slack sends Events API payloads to `/api/connectors/slack/events`.
4. Radioso verifies the Slack signature, checks replay age, deduplicates by
   `event_id`, and ignores bot-authored events and message edits, deletions,
   and joins. The event id is the only thing kept from an event that is not
   answered: it is stored without message text, for deduplication, and deleted
   after 7 days by a sweep in the document worker (`SLACK_INBOUND_EVENT_RETENTION_DAYS`;
   `0` keeps ids indefinitely). Under the Cloud Run task runtime the sweep is a
   scheduled push to `POST /internal/tasks/slack-inbound-event-retention/sweep`.
5. Radioso resolves the agent from the Slack channel binding. Direct messages,
   agent-pane sessions, and unlisted channels use the default agent. An
   un-mentioned channel message is answered only when it replies inside a
   thread the agent already answers in, or when the channel binding responds
   to every message; otherwise it is skipped. Opening the app's Messages tab
   sets the suggested prompts and starts nothing.
6. The Slack connector invokes the normal chat path with `sourceChannel:
   "slack"`.
7. Radioso posts the completed answer back to Slack through the stored bot
   token as a formatted message, in the thread the question came from.
8. If the typed turn outcome is `no_context`, the Slack connector can enqueue a
   `slack.post` escalation to the configured human channel.
9. Operators act on interactive messages in Slack. Slack sends the button click
   or form submission to `/api/connectors/slack/interactivity`. Radioso verifies
   the signature, identifies the operator by email, and resolves the action
   through the same approval and conversation-ownership services the dashboard
   uses. A human reply is delivered to the customer's original channel.

Logs and telemetry must use identifiers and counts only. They must not include
Slack tokens, signing secrets, message text, prompts, completions, retrieved
chunks, or document content.
