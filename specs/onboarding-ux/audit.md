# Onboarding UX audit — full findings (2026-09-01, main @ 3aaf8e079)

Companion to the summary delivered in chat. Three sweeps: frontend journey, backend bootstrap, operator/docs pathway.

## A. The journey as it exists today

### Operator (self-host) leg — good until first answer
1. readme quick start → `./run-dev.sh` → preflight (`scripts/bootstrap/preflight.mjs`, undocumented) → interactive env prompts (`scripts/bootstrap/prompt-flow.mjs`; provider key optional by design) → secrets generated → compose up (5 services) → app :3000.
2. First launch is a plain signup card — no instance setup wizard. First registration creates the sole OSS org (`OssOrganizationCreationGuard`; `postgresOssOrganizationBootstrap.ts:43` closes registration once any account exists). Later users join by invitation only.
3. Docs cover steps through "first cited answer" well (`docs-portal/content/quickstarts/run-locally.mdx`, `api-first-success.mdx`), then the authored path ends.

### User leg — screen by screen
1. `/` is the auth card (`frontend/app/page.tsx:142`); **no `/login`, `/signup`, `/register` routes** — mode is local state, signup un-linkable. No middleware.ts; gating is all client-side.
2. Register form (`register-form.tsx`): email, password, confirm, optional org name. Two server-controlled branches:
   - verification required → in-place "Verify your email" panel → user leaves for inbox → `/verify-email?token=` → **success does NOT log in**; back to `/`, retype credentials. Hardest funnel break.
   - dev auto-verify (`AUTH_AUTO_VERIFY_EMAIL`, hard-gated to NODE_ENV=development, `env.ts:316`) → straight in.
   - Self-host trap: default `MAIL_DRIVER=log` → verification link only exists in backend logs (`emailService.ts:62-73`). If send throws, token is already burned (`emailVerificationService.ts:77`).
3. Server provisions account + user + owner membership + workspace named "Default" — nothing else (`postgresOrganizationProvisioner.ts:36-74`). Default agent, ingestion settings, embedding space, API token are all lazily materialized on first read. `onAccountCreated` hook exists (`applicationModule.ts:191`) but **no OSS module registers it** (only EE usage-limits does).
4. Post-login redirect (`home-dashboard-redirect.ts:28`): first-run → `/w/{key}/agents/{agentId}`; otherwise → activity/Inbox. Gate = `shouldAutoActivateOnboarding` (`lib/onboarding.ts:80`): zero docs AND zero conversations AND localStorage flag unset.
   - Bugs: `workspaceCount` param accepted but never read (veteran's 4th empty workspace re-triggers first-run); localStorage-only state re-fires on new device/incognito and can never be revisited after completion.
5. **First-run experience** (`first-run-experience.tsx`): full-screen 3-step checklist — Add documents ("Upload" / "Try Radioso docs" sample import / API-SDK snippets) → Processing (2s poll) → Ask a question.
   - Renders ONLY on Agents→Chat; clicking "Upload documents" navigates to Knowledge and the checklist vanishes with no way back.
   - `markActive` (`onboarding.ts:236`) has zero call sites → once skipped/completed, no UI can ever reopen the guide.
   - Progress bar counts max 2 of "3 complete" (`first-run-experience.tsx:306`) — can never fill.
   - `SAMPLE_QUESTIONS` exported, never rendered anywhere.
   - Both "API or SDK" disclosures share one open flag.
   - Ends at "ask one question" — no agent, no action/handoff, no deploy.
6. Knowledge empty state (`document-list.tsx:258`) tells users "Starter docs are only used during the guided first-run flow" without linking back to it.
7. Backend counts `sampleDocumentsImported` from `metadata->>'sampleDocument'='true'` (`documentRepository.ts:137`) — **nothing in the repo writes that key**; frontend `importSampleDocs` doesn't set it. Always 0/false.
8. Agent creation: default agent implicit (materialized by `ensureDefaultAgent`, `agentService.ts:162`), explained nowhere. "New agent" (agent switcher) → chooser dialog → website-analyzer wizard (4 steps, decent; `lib/agent-wizard/wizard-shell.tsx`; ends in `window.location.href` full reload) — but **unreachable from first-run**; new users have no reason to open the switcher.
9. Deploy: Agents → Channels sub-nav group, `defaultOpen:false` (`dashboard-subnav.tsx:47-60`) → Web chat → embed/public-link settings (`website-embed-settings-controller.tsx`). No nudge from anywhere in onboarding. Single workspace token, reveal-only UI, admin-scoped, one per workspace (`authService.ts:766-836`).
10. Ray: floating tab only, no sidebar entry, no intro; empty-state pitch is retrospective ("what happened") — empty for a new workspace. Unconfigured-LLM state does deep-link to Settings → Providers (good).
11. Empty-workspace chat still runs the full retrieval pipeline and pays for a model call with an empty contexts block (`promptBuilder.ts:36-53`); no `no_documents` outcome on the answer path.
12. No product-analytics events on any onboarding step (first-run render, skip, sample import, first question, embed copy).
13. Invited teammates deliberately skip first-run (`invitation-accept-form.tsx:47-56` → Inbox) — by design, but they get zero orientation.

### Docs leg — fragmentation report (see explorer detail)
- **No "create your first agent" page exists anywhere in docs-portal.** Guides jump from document upload to directives/routines.
- readme's 3-step promise (upload → ask → `contact_human` handoff) has no doc or UI walkthrough for step 3 — the differentiator.
- Contradictions: readme lists embed harness :4321 as if run-dev starts it (it doesn't); run-locally.mdx calls the harness "Enterprise" while readme says widget is OSS; run-locally says starter docs auto-seed (they're an opt-in button).
- register→token→upload→ask sequence written 4 times in 4 voices (readme, run-locally, api-first-success, first-run component) with differing hosts.
- Production: deployment.mdx is Cloud-Run/Terraform only; self-hosting-operations assumes a production Compose deployment no page teaches; compose file has hardcoded postgres/postgres; no TLS/reverse-proxy/hardening doc.
- Mail/SMTP setup undocumented (the first blocker to inviting a second human). Invite/roles guide missing.
- 8 readme links drop out of the docs portal into raw in-repo markdown (webhooks, Slack, email skills…).
- Operators section is 9th in nav with no index page; quickstart "next" links never route to concepts/directives/routines.
- 124 env keys in .env.example, no reference table. `AUTH_AUTO_VERIFY_EMAIL` trap (refuses to boot outside development) undocumented.
- Zero in-product links to docs (`docs.radioso.ai` appears nowhere in frontend); settings tooltips are a parallel doc system (`settings-docs.ts`) covering only settings fields.
- No demo-seeding script; the docs screenshot workspace is a manual-prerequisite comment in `capture-screenshots.mjs:1-9`.

## B. Prior art
- `first-launch-onboarding-flow` branch: **contains zero commits of its own** (points at old main #740); the built work was uncommitted in a dead worktree and is gone. The validated design survives in memory: reusable AgentSetupFlow (purpose → knowledge → provision starter directives+routines → test), `POST /agents/:id/starter-pack`, response-language detector injection, first-launch profile step. Owner steers recorded: onboarding → agent-setup → domains dependency direction; agent created as a result of setup; provisioning additive.
- `borohhov/install-onboarding`, `borohhov/simpler-onboarding`: pre-rebrand relics ~700 commits behind; historical only.

## B2. Pre-product funnel (radioso.ai → tool), added 2026-09-01
- radioso.ai hero CTA "Get started" → `/#quickstart` anchor (self-host instructions); the hosted app (app.radioso.ai) is only a small nav pill "Log in / Sign up". The instant-gratification path is de-emphasized; the high-friction path is the primary CTA.
- Backend supports Google federated sign-in (provisions on first login, skips email verification entirely) but the UI has no button for it.
- Proposed: dual first-class CTAs (cloud + self-host), real linkable `/signup`, "check your inbox" as a first-class screen (resend / change address / dev-mode link surfacing), session issued on verify (auto-login).

## B3. Granular tokens — PR #1142 (role-based-mcp-access-design)
- Replaces the shared always-admin workspace token with personal API tokens (label, roleCeiling member|admin, expiresAt) and service accounts (displayName, role, rotatable credentials, quotas), default-deny route policy, API-access settings UI.
- Migration `158_machine_access.sql` is DESTRUCTIVE: legacy shared tokens tombstoned, no compat path.
- Onboarding impact: every "reveal the workspace token" surface (first-run API snippets, deploy step, docs' register→token→ask sequences) breaks conceptually on merge. Onboarding must teach create-named-credential + shown-once from day one. Mockup's deploy card reflects this.

## B4. Backend implications of the mockup design (2026-09-01)

**Substantial new pieces:**
1. Server-side setup state — per-workspace checklist (derived outcomes + persisted bits: purpose text, dismissal, notify-receipt confirmation, skips), GET/PATCH endpoints, migration, server-owned shouldShowFirstRun. WorkspaceSummaryService already derives half the signals; extend, don't duplicate.
2. Starter pack — POST draft/apply pair (purpose → directives + routine), prompt under backend/prompts/, response-language detector injection, fenced apply, rate-limited like agent-wizard. Rebuild of the lost branch design; composes AuthoredDirectiveService + RoutineDraftAssist.

**Small new pieces:** verify-tab session issuance + pending-registration poll/exchange ticket; dev-mode verification-link surfacing in registration response; test-notification send endpoint + mail-driver status exposure; llmConfigured flag on summary (generalize Ray's check); corpus-derived starter questions (new GenerationSurface on existing suggested-questions machinery); write sampleDocument metadata (or drop the counter); Ray setup-state context contributor.

**Exists already, UI-only:** Google sign-in — CORRECTION: the OAuth dance is EE-only (`/ee/auth/google/start` + `/status`); OSS has only the provider-agnostic `federatedLogin` service (authService.ts:415, links by verified email, no identity-link table). The login form already probes the EE status endpoint and shows a Google button when enabled; the register card does not — that button is the frontend gap. `GOOGLE_MAIL_OAUTH_*` env vars are the UNRELATED customer-email (Gmail skill) OAuth. Decision: keep sign-in EE/cloud-only (scene 0 is the cloud funnel; the self-host first user is the operator) or promote across the EE seam. Also existing: website analyzer + streams, upload/import, crawl jobs + doc-status polling for the readiness strip, embed/public-link settings, Inbox/needs-attention, notify destination settings.

**Dependencies/sequencing:** PR #1142 credentials (deploy step teaches its model; don't build against the shared token); notify delivery bug (#999 fixed routing only — delivery still broken, now launch-blocking for the handoff step); verify auto-login is an auth behavior change (session on verify).

**Cross-cutting per repo rules:** OpenAPI + SDK snapshot regen; two DB snapshots per migration; copilot tool descriptor or coverage-map exclusion for new operator surfaces; observability on starter-pack generation and test-notification dispatch; docs.

## C. Recommendations (summary — full rationale in chat deliverable)
1. **Quick wins:** real /login+/signup routes; auto-login on verify success; fix progress-bar count; render SAMPLE_QUESTIONS; split disclosure flags; honor workspaceCount; write sampleDocument metadata (or drop the counter); dev-mode surface of verification link; funnel analytics events; "Resume setup" entry (call markActive); link knowledge empty state back to setup.
2. **Server-side onboarding state:** persist checklist/dismissal per workspace (summary endpoint already derives most signals); replaces localStorage gate.
3. **One guided spine (rebuild of the lost design):** purpose → knowledge (wizard-as-step / upload / samples) → provision starter pack → test with suggested questions → make-it-act (contact_human) → deploy (embed/public link/token). Persistent compact sidebar checklist, not a one-shot takeover; same AgentSetupFlow mounted from first-launch and New-agent.
4. **Ray as onboarding concierge:** constructive empty state for fresh workspaces; drive setup via existing propose_* tools.
5. **Docs:** one canonical start-here chain; first-agent + make-it-act + mail + production-Compose + operators-index pages; kill contradictions and the 4x duplication; add in-product docs links.
