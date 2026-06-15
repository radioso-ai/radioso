# Quickstart: External Skills via MCP

Goal: add an external integration as **data** (no code) and use it in a routine.

## Add an integration (author flow)

1. **Settings → MCP Connections → New**: enter a display name + the server's Streamable-HTTP URL; choose auth (access token now, or OAuth once P2 lands) and provide credentials.
2. **Skill builder → New skill**: pick the connection → the screen lists the server's discovered tools (live `tools/list`) → pick one (e.g. `post_message`) → its inputs render as a form → **bind** some (`channel = #support`) and **expose** the rest (`message`) → name it (e.g. `handoff_slack`) → save.
3. **Routine authoring**: add a step that references `handoff_slack`; add transitions for the outcomes (success/failure now; named outcomes once P3 lands).

That's it — no code, no deploy. A second integration is the same steps with different data.

## Run the demo / validate

- **Mock-server demo (P1)**: point a connection at the in-process mock MCP server fixture; define a skill; drive a routine and watch it call the tool and follow the success vs failure branch.
- **Real Slack/Cal.com**: requires OAuth (P2) — their MCP servers (`mcp.cal.com`, Slack official) are OAuth-only. Once P2 lands, authorize the connection once, then the same flow works against the real server.

## Test (developer)

- Backend (TDD): mock MCP server fixture → ToolService → resolver (param merge) → executor (→ `RoutineSkillResult.status`) → routine integration (success + failure + safe-degrade on timeout/error). P3: distinct result payloads → distinct named outcomes, incl. a non-English conversation.
- Frontend (Playwright): connections CRUD, skill builder (discover → bind/expose → save), routine picker shows the skill + branches.

## Invariants to verify

- No component above the skill port (engine, routine runner, chat route) imports MCP.
- The model never selects a raw tool; only enabled skill definitions are invocable.
- No token/payload/PII in logs or traces; failure path within the timeout bound.
