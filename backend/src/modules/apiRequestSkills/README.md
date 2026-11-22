# API Request Skills Module

API request skills own what lets a routine call a REST API and use its answer:
the workspace's API connections, the `api_request` skill config, and the
executor that turns one routine step into one HTTP request and one typed result.
Reference: `docs/api-request-skills.md`.

## What it owns

- API connections (`connections/apiConnectionService.ts`): create, read, update
  and delete, the base URL rules, the credential (encrypted at rest, returned as
  `credentialMask`), default headers, and the refusal to delete a connection a
  skill in an agent's draft or published release uses (`api_connection_in_use`).
- Parameter placement: path placeholders, query string, JSON body with dotted
  keys nesting.
- Typed input resolution: each exposed value coerced to `text`, `number`,
  `boolean`, `date` or `email`, and the verified-only gate that settles
  `unverified` for a value a host did not verify.
- The executor (`executor/apiRequestSkillExecutor.ts`) and its outcome mapping
  from HTTP status and transport errors to `completed`, `not_found`,
  `rejected`, `missing_input`, `invalid_input`, `unverified` and `failed` with a
  reason.
- The test request that sends one real request as a skill would.
- The routine skill resolver (`routineSkillResolver.ts`) that exposes each skill
  and its declared outputs to the routine catalog.

## What it does not know

- Routines and turns. The module sees a skill, resolved input values and a
  context-trust flag; the routine engine reaches it through the resolver.
- HTTP egress policy. Public-address resolution, redirects, size and time caps
  live in `shared/infra/http/publicHttpRequest.ts`.
- The typed contract. Output paths, list shapes, roles and coercion are
  `shared/domain/skillDataContract/`, which is pure.

## Ports

- `ApiConnectionRepositoryPort`: persistence, implemented by
  `db/repositories/apiConnectionRepository.ts`.
- `ApiConnectionAuditPort`: declared here so the module does not cycle through
  audit.
- `SkillTargetUseReader` (`shared/domain/skillTargetUses.ts`): the agents and
  skills that use a connection, in drafts and published releases, implemented
  by `agentSkills` over the `agent_skill_target_uses` SQL function the delete
  trigger also calls.
- `ApiRequestSender`: the HTTP transport, injected by composition in
  `app/server/builders/apiRequestSkills.ts`.
- `ApiRequestSkillSource`: the skill row the conversation runs, which its
  release froze, satisfied by the conversation-scoped lookup in
  `app/composition/conversationSkills.ts`. The routine resolver reads the same
  set, so a draft edit reaches a conversation only once it is published. The
  connection the row targets is read live, like a webhook destination.

`public.ts` is the module's entry point. Routes live in
`app/http/routes/settingsApiConnectionRoutes.ts`; migration
`269_api_connections.sql` creates the table.

## Observability

- Span `api_request.skill.dispatch` with skill name, connection id, method,
  status, outcome, reason and the names of missing outputs.
- Counter `api_request_skill_dispatch_total{outcome,reason}`.
- Warn log `api_request_skill_failed` with ids and reason only.

A URL, header, credential, body or value is never recorded.

## Tests

- `cd backend && pnpm exec vitest run tests/unit/apiRequestSkills tests/unit/skillDataContract tests/unit/public-http-request.test.ts tests/unit/release-pinned-skill-runtime.test.ts tests/contract/settings-api-connections.contract.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/api-connection-repository.integration.test.ts tests/integration/agent-revision-skill-draft.integration.test.ts tests/integration/skill-target-published-release-guard.integration.test.ts`
