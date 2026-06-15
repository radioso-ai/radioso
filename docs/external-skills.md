# External Skills via MCP

External skills let an agent's routines call tools on an external MCP server. You
connect a server, define named skills that bind its tools, and reference those
skills from routine steps. Adding an integration is configuration, not code.

In practice there are three things to set up, in order: a **connection**, one or
more **skill definitions**, and a routine **step** that uses a skill. All of it
lives under an agent's **Behavior** settings.

## 1. Connect an MCP server

Open **Agent → Behavior → MCP connections** and add a connection:

- **Name** — a label for the connection.
- **Server URL** — the MCP server's HTTPS endpoint. It must be `https://`, must
  not embed credentials in the URL, and must resolve to a public host. Loopback,
  private, and internal addresses are rejected, both when you save and again
  before every outbound call. This protects your internal network.
- **Authentication** — *Access token* stores a bearer token. OAuth is planned and
  not yet available.

The access token is **write-only**. It is encrypted at rest and never returned by
the API or shown again. To replace it, edit the connection and enter a new token.

Connecting requires the `CONNECTOR_ENCRYPTION_KEY` environment variable to be set,
since credentials are encrypted with it. Without it, creating a token-based
connection fails with a clear configuration error.

## 2. Define a skill

Open **Agent → Behavior → External skills** and add a skill:

1. Pick a connection. Radioso discovers the server's tools live.
2. Pick a tool. Its inputs are read from the tool's own schema.
3. For each input, choose **Fixed value** (bound — you set it now) or **Filled by
   conversation** (exposed — the agent supplies it at run time).
4. Give the skill a name. The name is a lower-case identifier (for example
   `handoff_slack`) and must be unique within the agent.

The skill is validated against the tool before it is saved: the tool must still
exist, and the tool's required inputs must each be bound or exposed.

A connection cannot be deleted while a skill still uses it. Remove the skills
first.

## 3. Use a skill in a routine

In the routine editor, add a **tool** step and select the skill from the
dropdown. The dropdown lists the agent's defined external skills by name. At run
time the routine fills the exposed inputs, calls the tool, and branches on the
outcome (success or failure). See [Authoring Routines](./authoring-routines.md).

## Security model

The key points:

- **Tokens are encrypted at rest** and never returned. The server URL is held in
  plain configuration; secrets are not.
- **Outbound calls are guarded** against internal targets (no loopback, private,
  or link-local hosts), checked both at save time and immediately before each
  connection.
- **Only defined skills are callable.** A routine references a skill by name; the
  model never sees or chooses a raw discovered tool, and it cannot redirect a
  call. The set of skill definitions is the allow-list.
- **Calls carry only their params** — the bound values plus the exposed inputs the
  conversation provides. Nothing else is sent to the server.

## Managing connections and skills

Both connections and skills support full create, read, update, and delete. You
can rename a connection, rotate its token, disable a skill, or change a skill's
bindings or outcome map without recreating it (so routine references stay
intact). Re-binding a skill is re-validated against the tool's current schema.
