---
title: "External Skills via MCP"
description: "Configuration of external MCP server connections and unified named skill definitions for agent routines with encrypted credential storage."
last_updated: 2026-11-13
---

# External Skills via MCP

External skills let an agent's routines call tools on an external MCP server. You
connect a server, define named skills that bind its tools, and reference those
skills from routine steps. Adding an integration is configuration, not code.

Customer-owned email uses the shared OAuth substrate but has its own connection
model and transactional-mail boundary. See
[Customer Email Connections](./customer-email-skills.md).

In practice there are three things to set up, in order: a **connection**, one or
more named **skills**, and a routine **step** that uses a skill. A connection
belongs to the workspace, so you connect a server once and skills on any agent can
use it. A skill belongs to one agent.

## 1. Connect an MCP server

Open any agent's **Skills** tab and choose **Manage MCP connections** to add a connection
in the side panel. You can also open the panel when adding an MCP skill. The panel
shows the same connections from every agent in the workspace, and each one lists the
agents whose skills use it.
This connects your agents to external tools. **Channels → MCP** manages clients
that talk to an agent.

Every agent whose skills use a connection acts under its credential. Replacing a
token or re-authorizing takes effect for all of them, and so does a token the server
revokes. To keep one agent's access separate, add a second connection to the same
server with its own credential.

- **Display name** — a label for the connection.
- **Server URL** — the MCP server's HTTPS endpoint. It must be `https://`, must
  not embed credentials in the URL, and must resolve to a public host. Loopback,
  private, and internal addresses are rejected, both when you save and again
  before every outbound call. This protects your internal network.
- **Authentication** — choose *Access token* or *OAuth*.
  - *Access token* stores a bearer token you already have.
  - *OAuth* connects a hosted server that requires a one-time consent flow. See
    [Connecting an OAuth server](#connecting-an-oauth-server) below.

The access token is **write-only**. It is encrypted at rest and never returned by
the API or shown again. To replace it, choose **Replace token** on the connection
and paste the new one.

Choose **Test connection** on a saved connection to authenticate with the server
and list its available tools. The result shows a tool count or an error beside
that connection. The test does not invoke any tools. **Credentials saved** means
the credential is stored; use the test to check that the connection works.

When the server turns the token down, for example because it was rotated or
revoked on the server's side, the test and the skill form both say so and the
connection is marked **Needs re-auth**. Replace the token to bring it back. Skills
keep their binding to the connection, so nothing else needs to change.

Connecting requires the `CONNECTOR_ENCRYPTION_KEY` environment variable to be set,
since credentials are encrypted with it. Without it, creating a connection that
stores a secret fails with a clear configuration error.

### Connecting an OAuth server

Most hosted vendor MCP servers require OAuth. For these, the connection holds an
OAuth client configuration and you authorize it once; afterwards skills on it call
the server using stored, automatically-refreshed credentials.

To set one up:

1. Register Radioso as an OAuth client with the vendor. Use this redirect URL:
   `<APP_BASE_URL>/oauth/mcp-callback` (for example
   `https://app.example.com/oauth/mcp-callback`). The vendor gives you a client id
   and, usually, a client secret.
2. In **MCP connections**, choose **OAuth** and enter the server URL, the
   provider's **authorization** and **token** endpoints, the **client id**, the
   **client secret** (leave blank for a public PKCE client), and any **scopes**.
3. Save. The connection starts as **unconfigured**.
4. Click **Authorize**. Radioso opens the provider's consent screen. Approve it.
   On return, the connection becomes **authorized**.

The client secret and the issued tokens are **write-only** — encrypted at rest and
never returned by the API. The flow uses PKCE.

**Re-authorization.** Before each call, an expired access token is refreshed
automatically. If a refresh fails (for example the provider revoked access), the
connection is marked **needs re-authorization** and routine steps that use it take
their failure path. Open the connection and click **Authorize** again to restore
it.

Authorizing requires `APP_BASE_URL` to be set, since it forms the redirect URL.

## 2. Define a skill

Open the same agent's **Skills** list and choose **Add new skill**. The picker
shows capability tiles. **MCP tool** is enabled after at least one MCP connection
exists:

1. Pick the **MCP tool** tile.
2. Pick the connected MCP server as the target.
3. Choose one of the tools published by that server. Radioso discovers the list
   from the selected connection and turns the chosen tool's input schema into
   routine inputs.
4. Give the skill a name. The name is a lower-case identifier (for example
   `handoff_slack`) and must be unique within the agent.

Required tool inputs are exposed to the routine by default. Open **Routine
integration** to bind fixed values, include optional inputs, or edit declared
outcomes. Use **Advanced** to change invocation behavior.

The skill is validated against the tool before it is saved: the tool must still
exist, and the tool's required inputs must each be bound or exposed.

A connection cannot be deleted while a skill on any agent in the workspace still
uses it. The error names those agents, so remove their skills first. Deleting an
agent removes its skills and leaves the connection in place.

## 3. Use a skill in a routine

In the routine editor, add a **tool** step and pick the skill - the editor lists
the agent's skills, so you choose one instead of typing its name. Open the step
to bind each of the skill's inputs to a fixed value or to a variable the routine
holds, and to store the skill's outputs in variables for later steps. At run time
the routine sends those values, calls the tool, and branches on the outcome
(success or failure). See [Authoring Routines](./authoring-routines.md) for how
binding works.

## Cards from a skill's results

A skill can also answer a chat turn on its own: a directive bound to the skill
claims the turn, and the agent writes the reply from what the tool returned (see
[Agents and skills](../docs-portal/content/api/agents-and-skills.mdx)). When the
tool returns structured content, each object of an array in it is a record, such
as one listing, one product or one office.

When the agent's **Show cards in replies** switch is on (`replyCardsEnabled`,
the same switch that shows the pictures of an answer's documents) and the
visitor's chat renders reply blocks (the web chat, the embed and Test Chat all
do), the reply is written from those records and can show them as cards: a short lead in the text, and up to ten cards beside it, each with a
title, a line under it, a picture and a link. For a property search that returns
fifteen flats, a visitor who asks for flats in Mitte under 2,000 a month gets a
sentence and a carousel of the four that fit. A tool that returns records and no
text is answered from its records there. With the switch off, or on a channel
that shows no cards, such as voice, WhatsApp or email, the reply is written from
the tool's text alone, and a tool that returns no text leaves the turn to the
agent's usual answer.

The model decides which records to show and where in each record the card's
title, subtitle, picture and link are; Radioso reads every value from the
record itself. A title must be text or a number, and a picture or a link must be
a public `http` or `https` address. A field that is anything else is left off
its card. Cards with pictures come as a carousel, cards without as a list. When
the model names cards none of which can be built, the reply is written again
without cards, so its lead never points at a list that is not there.

What the model reads of the records is bounded: at most 20 records, each three
levels deep with up to 12 keys, 3 items of any array and 120 characters of any
string, within about 3,000 tokens. An address with a query, such as a signed
link, or one longer than 80 characters, is shown cut to its host and last path
segment; the card still gets the whole address.

A card's picture is the address a record names, copied for the conversation.
Radioso fetches it once, with an 8 MB cap, re-encodes it to WebP at 320 and 640
pixels wide, and serves the copy from its own image route, so the card keeps its
picture after a signed link expires. A job copies the pictures a few seconds
after the reply is stored, within 20 seconds each; a browser that asks for a
picture first gets it copied on the spot within 6 seconds, unless the server is
already copying four pictures, in which case the card shows without it until the
job has run. JPEG, PNG, WebP, GIF and AVIF are read. An SVG, a page that is not
a picture, a private address or an expired link leaves the card without a
picture.

The copies are deleted with the conversation, and a copy no stored reply carries
goes after a day. Test Chat shows the same cards and copies their pictures. A
routine's tool step shows no cards, and a visitor cannot pick a card: each card
opens its link.

## Call timeout

A skill's tool call is bounded by the `EXTERNAL_MCP_TOOL_CALL_TIMEOUT_MS`
environment variable — 30 seconds by default, up to a configured maximum of 90
seconds. Connecting to a server and discovering its tools use a separate,
fixed 10-second bound. A call that runs past its bound fails the routine step
with `mcp_timeout`.

## Security model

Four rules govern how credentials and calls are handled:

- **Secrets are encrypted at rest** and never returned. This covers access
  tokens, OAuth client secrets, and OAuth access/refresh tokens. The server URL
  and OAuth endpoints are held in plain configuration; secrets are not. Secrets
  are never written to logs or to per-agent settings.
- **Outbound calls are guarded** against internal targets (no loopback, private,
  or link-local hosts), checked both at save time and immediately before each
  connection.
- **Only defined skills are callable.** A routine references a skill by name; the
  model never sees or chooses a raw discovered tool, and it cannot redirect a
  call. The set of skill definitions is the allow-list.
- **Calls carry only their params** — the bound values plus the exposed inputs the
  conversation provides. Nothing else is sent to the server.

## Export and import

An agent's external-skill setup travels with its exported configuration, the same
way directives, branding, and skill settings do. The export includes the agent's
skill definitions and the MCP connections those skills use, as data.

Two things are handled with care:

- **Secrets stay in the secret store.** Static access tokens and OAuth client
  secrets are never written to an export. They appear as placeholders. OAuth
  access and refresh tokens are not exported at all; after import, authorize the
  OAuth connection again. The non-secret OAuth client details, such as endpoints,
  client id, and scopes, stay in the bundle so re-authorization is possible.
- **Skill-to-connection links use a key inside the bundle.** A skill points to one
  connection. The export records this link by a within-bundle key, not by the
  connection's database id.

Import reports each MCP connection and external skill in the bundle as unresolved
and leaves it for you to set up, because a connection needs its credential entered
or its OAuth flow run before it can serve. Add the connection under **Manage MCP
connections**, or reuse one the workspace already has, then re-create the skill.

## Managing connections and skills

Connections and skills are separate records. You can rename a connection, rotate
its token, disable a skill, or change a skill's bindings without putting
credentials in the skill form. Routine references stay stable because they use
the skill name.
