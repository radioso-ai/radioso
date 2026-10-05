# Email channel behaviour suite

Business scenarios for the email channel (spec 1403), run live against the real pipeline and a
real model: a customer emails a mailbox, and the suite checks what the business sees. The agent
answers by email (`sent`), drafts a reply for a teammate (`drafted`), stays out of it (`silent`),
or hands the conversation to a person (`handed_off`).

Each case runs on its own mailbox, in its own mode, through the mailbox harness
(`tests/support/emailMailboxHarness.ts`): the application composition with the local email
provider, raw mail in through the signed webhook, the coalesced review turn, the publication
decision, the `email.send` outbox, and the local driver's outbound spool.

## What's here

| File | What it is |
|------|------------|
| `corpus/` | Fernhill Tea Co., a fictional online tea shop in Vienna: shipping, returns and order changes, opening hours |
| `cases.ts` | The scenarios, the company and the agent instruction |
| `../../support/emailBehaviourSuite.ts` | Case vocabulary, step execution, scoring, the results table |
| `../../support/emailMailboxHarness.ts` | The harness: boot, seed, `inbound`, `settle`, `outcome`, operator actions, `spool` |
| `../../support/emailMailboxOutcome.ts` | The pure mapping from pipeline evidence to a business outcome |
| `../../../scripts/runEmailBehaviourEvals.ts` | The runner behind `pnpm run evals:email` |

The harness has two deterministic checks that run in CI without a model:
`tests/unit/eval-suite/email-mailbox-outcome.test.ts` (the outcome mapping, driven by the review
runner with a stub `respond` for every row of the spec's Engagement Outcome Table) and
`tests/integration/email-mailbox-harness.integration.test.ts` (the harness end to end over
Postgres, with a scripted review turn). A scripted turn scripts the review's model checks with it:
every email needs a reply, and every reply is complete. A live run calls the real reply triage and
completeness check, and a step's `turnRan` counts the host's review turns, so mail the triage sets
aside reads as `silent` with reason `no_reply_needed` and no turn.

## Running it

The run needs a disposable Postgres database with `pgvector` and an env file. The database name
must contain `email_behaviour` or end in `_test`, and the chat model must be mini-class; the runner
refuses anything else unless `--allow-database` or `--allow-model` names it.

```bash
docker exec radioso-postgres-1 psql -U postgres -c "CREATE DATABASE radioso_email_behaviour"
docker exec radioso-postgres-1 psql -U postgres -d radioso_email_behaviour -c "CREATE EXTENSION IF NOT EXISTS vector"
```

The env file (keep it gitignored, for example `.context/email-behaviour/.env`) sets:

```bash
NODE_ENV=development
DATABASE_URL=postgres://postgres:postgres@localhost:<port>/radioso_email_behaviour
LLM_PROVIDER=openai
OPENAI_API_KEY=<key>
OPENAI_CHAT_MODEL=gpt-5.4-mini
OPENAI_VECTOR_MODEL=text-embedding-3-small
CONNECTOR_ENCRYPTION_KEY=<openssl rand -base64 32>
SESSION_COOKIE_SECRET=<openssl rand -hex 32>
WORKSPACE_TOKEN_SECRET=<openssl rand -hex 32>
MAIL_DRIVER=log
WORKER_DISPATCH_DRIVER=noop
DOCUMENT_STORAGE_DRIVER=local
DOCUMENT_STORAGE_LOCAL_PATH=<absolute path>/document-storage
EMAIL_CHANNEL_PROVIDER=local
EMAIL_CHANNEL_INBOUND_DOMAIN=in.local.test
EMAIL_CHANNEL_WEBHOOK_SECRET=whsec_<openssl rand -base64 32>
EMAIL_CHANNEL_WORKERS_ENABLED=true
```

Then, from `backend/`:

```bash
pnpm run evals:email -- --env-file ../.context/email-behaviour/.env --migrate > ../.context/email-behaviour/app.log
pnpm run evals:email -- --env-file <path> --case auto-covered-question --case operator-only
pnpm run evals:email -- --env-file <path> --no-judge --out <dir>
```

The runner seeds the workspace, operator, agent and corpus on the first run and reuses them after,
processes the documents in-process (no document worker needed), runs one sample per case
(`--samples N` for more), and prints the table on stderr. Application logs go to stdout. It writes
`email-behaviour-results.json` (every step's typed outcome, checks, settle report and model calls)
and `email-behaviour-table.md` to `--out`, by default the repository's `.context/email-behaviour/`.
The local provider spools mail in `spool/` under the same directory, and mail on one thread inside
two seconds shares a review.
It exits non-zero when an `assert` case fails; `record` cases never gate.

A full run is about 18 review turns plus one judge call per judged reply, on the configured chat
model.

## Adding a case

Add an entry to `emailBehaviourCases` in `cases.ts`:

- `mode` is the mailbox's engagement mode: `operator_only`, `draft` or `auto`.
- `steps` is the conversation: `customer` emails (`replyTo: "thread"` threads a reply by
  `In-Reply-To` and `References`, `headers` adds lines such as `Auto-Submitted`), and operator
  actions: `take_over`, `release` (optionally with `editedText`), `operator_reply`, `set_mode`.
- `expect` on a step names the accepted outcomes (`kind`, optional `reason`), and optionally the
  ownership, the Inbox attention lane, the `Auto-Submitted` header, the draft's grounded label, and
  whether a review turn ran. An expectation without `sent` also checks that no email went out.
- `reply` checks the sent text, or the draft when nothing was sent: `mentions` and `doesNotMention`
  are patterns; `judge` grades the reply against a reference and criteria with the LLM judge.
- `gate: "assert"` gates the run. Use `gate: "record"` for a business question the product has not
  settled; the table reports what happened and whether it matched the expectation, if one is given.

Customer-facing judgments (language, invented facts, promised actions) belong in `judge` criteria
here, in the eval layer, never as keyword lists in product code.
