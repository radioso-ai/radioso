# Quickstart: Email Channel (1403), local development

This is for developers working on the feature. The operator-facing setup guide is `docs/email-channel.md` and `docs-portal/content/operators/email-channel.mdx`, written in the same change (FR-044). Nothing here needs DNS, an external mailbox, a Resend account or a live model, except the S0 spike section.

## 1. Environment

Add to `.env`. Each variable is also added to `.env.example` with a comment.

```bash
# Enables the channel. Unset = the email plugin, routes and workers are not registered.
EMAIL_CHANNEL_PROVIDER=local                 # resend | local
EMAIL_CHANNEL_INBOUND_DOMAIN=in.localhost.test
EMAIL_CHANNEL_WEBHOOK_SECRET=whsec_bG9jYWwtZGV2LXNlY3JldC0wMDAwMDAwMDAwMDA=
EMAIL_CHANNEL_WEBHOOK_SECRET_PREVIOUS=       # optional, used during signing-key rotation
EMAIL_CHANNEL_WORKERS_ENABLED=true           # default false; rollout ships workers disabled
EMAIL_CHANNEL_TASK_QUEUE_NAME=               # Cloud Tasks queue; unset = no-op drain push (interval worker drains)

# Resend only (EMAIL_CHANNEL_PROVIDER=resend). Falls back to RESEND_MAIL_API_KEY (transactional mail)
# when unset; set this only to give the channel its own key.
RESEND_CHANNEL_API_KEY=
RESEND_CHANNEL_REGION=us-east-1              # derived from the stack's Terraform region in deployed environments

# Existing; leave as is for local work. Channel mail is redacted by every driver.
MAIL_DRIVER=log
```

Coalescing (60s), the raw-MIME cap (2 MiB), event retention (30 days), and
the review retry limit (4 attempts) are constants, not env vars:
`EMAIL_COALESCE_SECONDS` and `EMAIL_RAW_MAX_BYTES` in
`emailInboundProcessor.ts`; `EMAIL_REVIEW_MAX_ATTEMPTS` and
`EMAIL_REVIEW_HISTORY_MESSAGES` (10) in `emailReviewRunner.ts`;
`EMAIL_EVENT_RETENTION_DAYS` in `emailChannel/maintenance/emailChannelSweep.ts`.
A test or the behaviour harness overrides any of these but the history
window, plus the local spool directory, through `EmailChannelOptions`
(`backend/src/app/composition/emailChannel.ts`) rather than env.

The `local` provider uses three adapters:
- `LocalInboundEmailReceiver` verifies the same Svix-format signature as production. Its `fetchMessage(id)` reads `${LOCAL_EMAIL_SPOOL_DIR}/${id}.eml` — fixed at `backend/.email-spool` (`mail/adapters/localSpool.ts`), regardless of the working directory.
- `LocalEmailDomainProvisioner` returns fixed DNS records in `pending`. `pnpm run email:dev -- verify-domain <domain>` flips them to `verified`.
- The existing `log` / `noop` `EmailDriver` returns a synthetic `providerMessageId` and a `deliveredMessageId` equal to the supplied one, and logs only redacted fields.

The API and worker containers in `./run-dev.sh` both mount `backend/`, so the spool directory is shared.

## 2. Run

```bash
./run-dev.sh                       # API + worker; the worker's interval loop drains email jobs locally
cd backend && pnpm run db:migrate  # if not auto-run
```

Create a mailbox through the settings card (Agent → Channels → Email) or the API:

```bash
curl -sX POST "http://localhost:8080/api/v1/workspaces/$WS/email-channel/mailboxes" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"address":"support@customer.test","displayName":"Support","agentId":"'"$AGENT"'","engagementMode":"operator_only"}'
# Response includes relayAddress: <relayToken>@in.localhost.test
```

## 3. Simulate the provider webhook with a fixture

```bash
cd backend
pnpm run email:dev -- inbound \
  --fixture tests/fixtures/email-channel/mime/first-contact.eml \
  --relay "<relayToken>@in.localhost.test"
```

`backend/scripts/emailChannelDev.ts` (dev-only, never shipped in the image entrypoint) does the following:
1. Writes the fixture to the spool as `<generated email_id>.eml`, with the relay address injected as `Delivered-To`.
2. Builds an `email.received` envelope shaped like Resend's (`email_id`, `from`, `to`, `cc`, `received_for`, `message_id`, `subject`).
3. Signs it with `EMAIL_CHANNEL_WEBHOOK_SECRET` (`svix-id`, `svix-timestamp`, `svix-signature`).
4. POSTs it to `http://localhost:8080/api/connectors/email/webhook`.

Other subcommands:
- `inbound --replay <svix-id>` re-sends an event, to test dedupe.
- `delivery --intent <sendIntentId> --type bounced` posts an outbound status event.
- `verify-domain <domain>` marks a local domain verified.

Fixture corpus, committed under `backend/tests/fixtures/email-channel/`:

| Directory | Contents | Covers |
|---|---|---|
| `mime/` | first-contact, pre-reply follow-up (`In-Reply-To` = own first message), header-threaded reply, token-only reply, two-mailbox message, participant mismatch, HTML-only, Gmail / Outlook / Apple quoted replies, attachments, encoded-word subjects, non-UTF-8 charset | SC-002, FR-013/014 |
| `protocol/` | `Auto-Submitted: auto-replied`, `Precedence: bulk`, `X-Auto-Response-Suppress`, `List-Id`, DSN `multipart/report` naming a Radioso id and one naming a foreign id, self-sender, spam verdict, auth-failed, unknown verdict | SC-003 |
| `webhooks/resend/` | recorded `email.received`, `email.delivered`, `email.bounced`, domain payloads from the S0 spike | adapter contract tests |

## 4. Tests

```bash
cd backend
pnpm exec vitest run tests/unit/email-channel            # pure functions and keystone services: classification, routing, thread protocol, disposition, publication, headers, quoted history, send-intent transitions
pnpm exec vitest run tests/unit/mail                     # header values, MIME normalizer, driver redaction and required result fields, Resend adapters vs fixtures
pnpm exec vitest run tests/unit/handoff                  # held-reply state and service, ownership supersede scopes
pnpm exec vitest run tests/unit/chat/turn-execution-capabilities.test.ts tests/unit/chat/review-turn.test.ts
pnpm run test:unit                                       # full unit suite (builds workspace packages first)
pnpm run test:contract                                   # webhook, host port, settings/held-reply/delivery-failure routes, OpenAPI drift, route policy, catalog coverage
pnpm run test:integration                                # thread protocol interleavings, crash recovery, release atomicity, held-reply visibility, send idempotency and fencing, budgets
```

`pnpm exec vitest` skips the workspace package builds. Run `pnpm run test:unit` once after pulling, or after editing `packages/connector-api` or `packages/conversation-contract`.

Integration tests need the disposable database recipe: a name ending in `_test`, plus `RADIOSO_INTEGRATION_DATABASE_NAME` set as an acknowledgement (`packages/integration-test-support`). The crash-at-boundary suite (`tests/integration/email-channel-crash-recovery.integration.test.ts`, SC-007) injects a failure at each stage boundary through a test-only fault hook on the worker: event persisted, fetched, resolved and reserved, ingested, indexed; outbox claimed, queued-auto materialized, provider accepted before record, recorded before delivered-id fetch; publish before review completion. It asserts exactly one conversation message per inbound and at most one provider accept per intent. The provider accept is counted by a fake `EmailDriver` that honours idempotency keys the way Resend does.

Frontend:

```bash
cd frontend
pnpm test                                                # non-visual logic: needs-attention merge for held replies and delivery_failed, email channel catalog entry, setup-check polling state
PLAYWRIGHT_PORT=3317 pnpm run test:e2e -- email-channel  # journeys: domain setup, mailbox binding, draft review, operator reply
```

Use a workspace-specific `PLAYWRIGHT_PORT` when other worktrees are running e2e. The e2e specs stub the backend email-channel API at the network layer for DNS and provider states, and drive real inbox flows against the dev backend with the `local` provider.

Copilot:

```bash
cd backend
pnpm exec vitest run tests/unit/operatorCopilot/copilot-catalog-coverage.test.ts   # every new operationId mapped or excluded
pnpm exec vitest run tests/unit/operatorCopilot/copilot-eval-suite.test.ts         # deterministic Ray rows incl. email read tools
```

## 5. Deterministic eval rows

The spec's Engagement Outcome Table is committed as data in `backend/tests/fixtures/conversation-quality/emailOutcomeTable.ts`, one row per table line. `backend/tests/unit/eval-suite/email-outcome-table.test.ts` drives the review runner through a stub `ConnectorChatPort.respond` that returns each row's typed turn result. For every row it asserts:
- the publication decision;
- a held reply exists or not;
- no send intent and no `email.send` outbox row for every non-publish row (SC-005);
- the attention kind;
- that held-reply text never appears in `GET` history endpoints (SC-004).

It runs in normal CI (`pnpm run test:unit`).

Live review-turn behaviour is a nightly concern. Cases tagged `email` in `backend/tests/fixtures/conversation-quality/cases.ts` run real review turns and assert `grounding` and `coverage` facts for a covered and an uncovered question:

```bash
cd backend
pnpm run evals -- --tag email     # live; needs Postgres, OPENAI_API_KEY, a running document worker
```

## 6. S0 spike against real Resend (one-off, not CI)

This is run once by the implementer with a Resend test account and two throwaway tenants (Google Workspace and Microsoft 365) to settle research A2, A4, A7 and A9:
1. Register a test relay domain with receiving enabled.
2. Forward from each tenant: base address, plus-address, reply to a Radioso-sent message.
3. Send with a supplied `Message-ID` and `Auto-Submitted` and inspect the raw message received.

Each payload is saved to `backend/tests/fixtures/email-channel/webhooks/resend/`, with addresses replaced by `example.test` placeholders. The outcome is recorded in `research.md` under the matching item's "Open risk".
