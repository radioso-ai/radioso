---
title: "External Skills via MCP"
description: "Configuration of external MCP server connections and unified named skill definitions for agent routines with encrypted credential storage."
last_updated: 2026-08-02
---

# External Skills via MCP

External skills let an agent's routines call tools on an external MCP server. You
connect a server, define named skills that bind its tools, and reference those
skills from routine steps. Adding an integration is configuration, not code.

Customer-owned email uses the shared OAuth substrate but has its own connection
model and transactional-mail boundary. See
[Customer Email Connections](./customer-email-skills.md).

In practice there are three things to set up, in order: a **connection**, one or
more named **skills**, and a routine **step** that uses a skill. Connections are
managed separately from skill authoring.

## 1. Connect an MCP server

Open the agent's **Skills** settings, then use **Connections** to add an MCP
server:

- **Name** — a label for the connection.
- **Server URL** — the MCP server's HTTPS endpoint. It must be `https://`, must
  not embed credentials in the URL, and must resolve to a public host. Loopback,
  private, and internal addresses are rejected, both when you save and again
  before every outbound call. This protects your internal network.
- **Authentication** — choose *Access token* or *OAuth*.
  - *Access token* stores a bearer token you already have.
  - *OAuth* connects a hosted server that requires a one-time consent flow. See
    [Connecting an OAuth server](#connecting-an-oauth-server) below.

The access token is **write-only**. It is encrypted at rest and never returned by
the API or shown again. To replace it, edit the connection and enter a new token.

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

A connection cannot be deleted while a skill still uses it. Remove the skills
first.

## 3. Use a skill in a routine

In the routine editor, add a **tool** step and pick the skill - the editor lists
the agent's skills, so you choose one instead of typing its name. Open the step
to bind each of the skill's inputs to a fixed value or to a variable the routine
holds, and to store the skill's outputs in variables for later steps. At run time
the routine sends those values, calls the tool, and branches on the outcome
(success or failure). See [Authoring Routines](./authoring-routines.md) for how
binding works.

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
MCP connections and skill definitions as data.

Two things are handled with care:

- **Secrets stay in the secret store.** Static access tokens and OAuth client
  secrets are never written to an export. They appear as placeholders. OAuth
  access and refresh tokens are not exported at all; after import, authorize the
  OAuth connection again. The non-secret OAuth client details, such as endpoints,
  client id, and scopes, stay in the bundle so re-authorization is possible.
- **Skill-to-connection links are rebuilt on import.** A skill points to one
  connection. The export records this link by a within-bundle key, not by the
  connection's database id. On import, Radioso recreates the connections first,
  then re-binds each skill to its connection using that key.

In practice, an exported bundle round-trips: import recreates the connections
(minus secrets) and the skill definitions, and re-links each skill to its
connection. If a skill refers to a connection that is missing from the bundle,
that skill is reported as unresolved and skipped — a skill cannot exist without
its connection.

## Managing connections and skills

Connections and skills are separate records. You can rename a connection, rotate
its token, disable a skill, or change a skill's bindings without putting
credentials in the skill form. Routine references stay stable because they use
the skill name.
