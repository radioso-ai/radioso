# Implementation plan: Track 2, cards from tool results, selection, routine binding (#1763)

**Status**: 2a.0 merged (#1778). 2a.1 built: §3 describes it as built, with its deviations from the draft. 2a.2 and 2b are drafts.

**Spec**: `specs/1763-reply-blocks/spec.md`, including its Track 2 amendment (D8–D12).
**PRs**: 2a.0 substrate → 2a.1 cards from skill results → 2a.2 selection on the web → 2b routine binding and the `item` slot. API sources and provider plugins are out of this plan (spec amendment, "Later").
**Base**: `origin/main` at 6fb565f8d7. A `(1a)` reference is to `origin/feat/reply-blocks-answer-side` (#1772), and `(1b)` to `origin/feat/reply-blocks-chat-cards` (#1775). 2a.1 stacks on both.

## 0. Where the code contradicts the brief

| Assumption | What the code says | Consequence |
|---|---|---|
| Reuse "the image codec visitor-image input extracted" | Not extracted. It is `visitorImages/services/imageNormalizer.ts`: it sniffs JPEG, PNG and WebP only (`:20-25`) and emits one JPEG (`:41-48`). Its decode slots are process-wide, 2 slots with a 5 s wait (`:14`). 1c plans the extraction but has not started. | 2a.0 extracts `shared/infra/images` with WebP 320/640, unless 1c lands first. Whichever lands first owns it. |
| `fetchPublicUrl` is ready to use | It has no timeout and no byte cap (`shared/infra/http/publicUrlFetch.ts:60-83`). | 2a.0 adds `publicBytesFetch.ts`, the helper 1c also plans. |
| The skill-result reply is "free text built from `answer`" | True. It is also plain generation with no response format (`assistantReplyComposer.ts:85-91,146-153`), so there is nowhere to put a head. | 2a.1 adds an envelope mode, used only when `present` is offered. Streaming goes through `StructuredAnswerFieldReader` (`structuredAnswerFieldReader.ts:118`). |
| The routine step reply can take a head | It is generated through `ConversationModelGateway`, whose request has no response format (`conversation-contract/modelGateway.d.ts:5-14`; `routineStepRenderer.ts:518-552`). | 2b renders a presenting step host-side, the way the grounded step renderer does (`routineGroundedAnswerRenderer.ts:61-78,217-235`; chosen at `routineStepRenderer.ts:499-514`). The package's prompts stay untouched. |
| A routine skill step "stages a `skill_result`" for the reply | It stages `outputs` only and drops `answer` (`routineRunner.ts:215-221`). Both step renderers read only `retrieval.context` (`routineStepRenderer.ts:209-240`; `routineGroundedAnswerRenderer.ts:45-59`). | The presenting renderer selects the staged entry whose `metadata.stepId` equals the binding's `fromStep`. |
| Slot type `item` holds `{key, title, …}` | Slot values are scalars (`slotValue.ts:69-93`). Objects render as `[object Object]` in step text (`stepReferences.ts:15-29`) and in notices (`routineEndingNotificationText.ts:46,84`). The extractor and the routine-exposure tool switch on slot type (`routineNextStepSelector.ts:73,325-345`; `routines/exposure/agentToolDescriptor.ts:34-44`). | 2b changes every reader listed in §4. |
| `captureKey` names the receiving slot | It is valid only on approval steps (`routine-definition/src/index.ts:300-306`), and it compiles to `await.decision` (`routines/compiler.ts:177-190`). | 2b allows it on a `chat` step that has a `present` binding. |
| MCP images can be "fetched right after the turn" | MCP `image` content carries base64 bytes, not URLs. | The intake uploads the raw bytes during the tool call (2a.1). The job only re-encodes them. |
| The image route "fetches on demand" | The port returns null for anything not servable (`(1a) replyImageAddress.ts:58-61`). | The route stays as is. On-demand capture lives in the tool-image lookup implementation. |
| Selection validated server-side, "like the web" | Suggestion clicks are not checked against stored messages today. The consent stack adds the first such check (`origin/feat/routine-consent-button-click:…/consentTurnPort.ts:88`) and merges four copies of the input-method vocabulary into one (`shared/domain/chatInputMetadata.ts`, #1759). | 2a.2 rebases on #1759. Otherwise it must edit four schemas (`publicChatRouteSchemas.ts:65-77`, `assistantChatSchemas.ts:11-22`, `agentTurnProbe.ts:31-42`, `db/repositories/messageInputMetadata.ts:19,42`). |
| Slice 1 cards survive a routine retrieval step | The routine grounded renderer does not carry `blocks` (`routineGroundedAnswerRenderer.ts:80-95,133-164`), so a `present` offered there is built and then lost. | A slice-1 bug on #1772. Fix it there; 2b relies on the same carry. |
| The OpenAPI adapter is "tested, no backend caller" | Confirmed. It also lets the model set `headers` that override auth (`openApiAdapter.ts:92,288-292`), reads bodies with no cap or timeout (`:214-220,296-301`), defaults to `globalThis.fetch` and `http://localhost` (`:237-238`), and never sets `answer` (`:319-323`). | Recorded for "Later". Not used here. |
| Connector plugins can contribute tools | Confirmed absent: `ConnectorContext` exposes chat, ingestion and sources only (`connector-api/connectorPlugin.d.ts:326-336`). | "Later". |
| Webhook skills could feed cards | They discard the receiver's response (`webhookSkills/executor/webhookSkillExecutor.ts:96-107`). | Out of scope. |
| An eval can exercise a tool | Eval routine skills are seeded as webhook skills that return nothing (`scripts/runEvals.ts:329-353`, `evalRunnerSupport.ts:241`). | 2a.1 adds a loopback stub MCP server for evals, allow-listed only in the eval composition. |

## 1. Cross-PR decisions

- **Migrations.** Main ends at `256_visitor_images`. Other branches already hold numbers:
  - 257 is #1772 (`257_document_images`);
  - 258 is #1777 (`258_visitor_images_test_chat`);
  - the consent stack (#1758 onwards) holds `254_routine_consents.sql` and must renumber.

  2a.1 and 2b take the next two free numbers at merge time. Today that means 259 or higher, and 260 or higher once consent renumbers. Recheck with `git ls-tree origin/main backend/src/db/migrations` before pushing. Each migration runs `pnpm run db:types` **and** `pnpm run db:schema`.
- **One flag** (not taken in 2a.1, see §3). `replyCardsEnabled` gates evidence images (1c) and skill-result cards (2a.1). Whichever PR lands first adds it, using the nine files listed in the 1a plan ("Moved to 1c"), bumping the agent config version once, and adding the Ray agent-settings descriptor. `agents/domain.ts` is at exactly **1000** lines, so its defaults block (`:63-75`) moves to `agentDefaults.ts` first. A routine binding needs no flag: authoring it is the opt-in.
- **Head shape.** One field name, `present`, with a schema per source.
  - Evidence keeps `{images, caption}` (`(1a) presentHead.ts:16-45`).
  - Tool records use D8's `{records, fields, caption, selection}`. A routine step's schema omits `selection`.
  - Item handles are plain strings, not a per-turn enum, so the provider's schema cache holds (the rule at `directiveAdherence.ts:150-157`).
- **Stored origin.** `StoredReplyBlock` (`(1a) chat/contracts/replyBlocks.ts:35-45,91`) gains a server-only `origin`. Presenting a block never writes it. Selection and the routine read it.
- **Sequencing.** 2a.0 → 2a.1 (after #1772 and #1775) → 2a.2 (after #1759) → 2b (after #1739, which moves `RoutineStep` to `conversation-contract/routineGraph.d.ts` and splits `routineRunner.ts`).

## 2. PR 2a.0: substrate (extraction only, no behaviour change; merged as #1778)

- **`shared/infra/images/`**: `imageSniff.ts`, `guardedDecode.ts` (pixel cap and decode slots, from `imageNormalizer.ts:14-23,64-80`), `encodeJpegUnder.ts` (the visitor path, moved unchanged) and `encodeWebpRenditions.ts` (320 and 640, metadata stripped).
  - The accepted types are a parameter; visitor images keep JPEG, PNG and WebP. GIF (first frame) and AVIF are added for tool and document images. SVG is always refused.
  - Each caller gets its own slot pool, so on-demand tool captures cannot starve visitor uploads.
  - `visitorImages/services/imageNormalizer.ts` delegates to the new modules, and its tests stay green unchanged.
- **`shared/infra/http/publicBytesFetch.ts`**: `fetchPublicUrl` plus `AbortSignal.timeout`, a streaming byte cap, `Accept: image/*`, and the redirect re-check the dispatcher already performs.
- **Ratchet offsets** for 2a.1 and 2a.2:
  - `app/server/dependencies.ts` (1489 on 1a, baselined): move the job-handler list (`:1261-1275` on main) to `app/composition/backgroundJobHandlers.ts`.
  - `app/server/builders/chat.ts` (**1000** on 1a): move `buildMcpConverseServices` to `builders/mcpConverse.ts`.
  - `conversation-contract/index.d.ts` (2119, baselined): move `SkillOutcome*` (`:419-433`) to `skillOutcome.d.ts`.
  - `chatSessionPreparer.ts` (1308, baselined): move the facet-eligibility pair, as the 1a table lists.
  - Re-record with `pnpm run lint:file-size:baseline`.
- **Tests:** a codec table (magic bytes, SVG and polyglots refused, pixel cap, WebP without EXIF); `publicBytesFetch` (timeout, cap, private address, private redirect).
- **Size:** about 16 files, +650 / −380. Small.

## 3. PR 2a.1: cards from a skill's result (as built)

### Deviations from the draft of this section

| Draft | Built | Why |
|---|---|---|
| One flag, `replyCardsEnabled`, gates evidence images and skill-result cards (§1). | No flag. Cards are offered on the client's `reply.blocks` capability and the presence of records. | Slice 1 shipped evidence pictures on the capability alone (#1772); a flag for half of the same feature would split one behaviour across two gates. No agent config version bump and no Ray descriptor follow. |
| `present` carries `selection` (D8). | It does not; every block is `selection: "none"`. | Nothing acts on a selection before 2a.2, which adds it with the Select action. |
| "No Test Chat cards" (non-goal, 1a R2). | Test Chat declares `reply.blocks`, its completion carries the blocks, and its address pictures are copied as unbound rows (`conversation_id` null, swept after a day). | Decided for this PR: operators try cards where they test the agent. |
| The model's view cuts every address to origin and last segment. | A short address with no query is shown whole; a long or signed one is cut, and the section says a cut one is incomplete. | The first live run showed mini linking the cut addresses in the reply text. |
| A loopback stub MCP server allow-listed in the eval composition. | An in-process MCP server over an in-memory transport, registered as the eval run's external-skills executor through an `ApplicationModule`. | No address is dialled, so there is no origin to allow-list. |
| `tests/live/tool-result-cards.verify.test.ts`. | Not built: the three `tool-cards` eval cases cover carousel, no pictures and no match, live and deterministically. | The eval cases are the gate the plan asked for. |
| `source_object_path`. | `source_object` jsonb `{bucket, objectPath, generation}`. | The eraser hands the object to the deletion job without a storage locator. |
| Offsets in `chatTurnLifecycle.ts` by moving the audit builders. | Moved `CutReplyStore`/`CutReplyStoreInput` to `cutReplyMessage.ts`. | The audit builders already moved (`assistantTurnAuditEvents.ts`); the cut-reply port is the next self-contained piece. |

### Design answers

| Module | Knows | Must not know | Port, and to whom |
|---|---|---|---|
| `chat/services/replyBlocks/toolRecords.ts` (pure) | The walk, handles, D8's caps, the compact view, JSON Pointer resolution (RFC 6901, no `-`) | Transports, storage | `ToolRecordLedger.fromOutcome(outputs, media)` → `{size, promptSection(), record(handle), mediaImageId(value)}` |
| `…/recordPresentHead.ts` + `recordBlockBuilder.ts` | The head schema; building items and dropping invalid ones; `origin`; allocating tool-image ids | Bytes, fetch | Pure; `buildRecordBlock` returns `{block, dropped, toolImages}` |
| `…/skillResultReplyBlocks.ts` | The offer rule (D8), metrics | MCP | `offerFor(session, skillName, ledger)` → `ReplyPresentOffer \| null`, used by the skill-result renderer |
| `…/presentReplyEnvelope.ts` (pure) | The `{present, answer}` response format and reading it | What is presented | Used by `AssistantReplyComposer` when an offer is passed |
| `modules/toolImages/` | Rows, intake, capture, on-demand lookup, eraser, sweep, the `tool-images` folder | Blocks, chat, MCP | `ToolImageRowWriter` (turn persistence), `ToolImagePreviewRecorder` (Test Chat), `ToolImageIntake` (externalSkills); the lookup and job handlers to composition |
| `externalSkills` | MCP `image` content → a per-call `McpToolImageSink` → `SkillOutcome.media` | Rows, cards | The executor binds `ToolImageIntake` to the calling conversation; ephemeral conversations get a sink that drops and counts |
| `app/composition/toolImages.ts` | The object store over document storage, the composite reply-image lookup, the jobs, the preview recorder | Product rules | |

**Dependency direction:** chat → `toolImages/contracts` (types and ports only); externalSkills → `toolImages/contracts`; toolImages → `shared/infra/{images,http}` and `shared/background-jobs`. toolImages imports nothing from documents (the first cut did and closed a module cycle through retrieval; the lookup now returns its own rendition shape, which composition puts behind the documents' lookup). Checked with `cd backend && pnpm run lint`.

### Seams

1. **The outcome stays renderable.** `hasRenderableResult` (`chat/services/agentSkillTurnSkillProvider.ts`) is used by `app/composition/builtIn/agentSkillTurnSkillProvider.ts` and the skill-result renderer. Neither text nor records keeps `empty_answer`.
2. **Findings.** Without an offer: the skill's text exactly as before, or the records when there is no text. With an offer: the records section (≤ 3,000 tokens) first, then the text capped to what is left of 4,800, unless it only repeats the structured content as JSON.
3. **The envelope.** With an offer, the composer appends `skill-result-present-records.md` to the prompt and asks for `presentReplyResponseFormat(extension)`; `tryComposeAnswer` reads the whole envelope, `streamAnswer` streams `answer` through `StructuredAnswerFieldReader`. Without one, the request is byte-identical (golden).
4. **The block** goes on `ChatPresentedAnswer.replyBlocks`, so persistence, the wire and history need no new code; `presentReplyBlocks` drops the server-only `origin`.
5. **Image rows in the turn's transaction.** `PresentedReplyBlocks.toolImages` → `chatTurnLifecycle` → `AssistantTurnPersistencePort.completeAssistantTurn({toolImages})` → `PostgresAssistantTurnPersistence` calls `ToolImageRowWriter.record(trx, …)` after the message insert and writes the returned capture jobs in the same transaction; the existing wake runs after commit.
6. **The MCP intake.** `sdkMcpToolService.ts` hands `image` blocks to `keepMcpImages` (at most 4, 5 MB each, JPEG/PNG/WebP/GIF/AVIF by declared type, re-sniffed by the intake). Its `callTool` returns a `SkillOutcome`, so `media` passes the tool bridge untouched.
7. **Storage.** `DocumentStorageFolder` gains `"tool-images"`; leaves are `<id>-source` and `<id>-w320`/`-w640`. Workspace purge sweeps the prefix.
8. **Capture job.** `tool_images.capture`, payload `{imageIds ≤ 10}`, first run 5 s after commit, 4 attempts at 30 s / 2 min / 10 min, then `retries_exhausted`. Transient outcomes (`timeout`, `unreachable`, `busy`) release the row; permanent ones fail it, clear the source, and hand any source object to `tool_images.object_deletion`.
9. **On demand.** `ToolImageLookup.findServable`: stored → served; waiting → captured within 6 s, single-flight per id, polling a row another capture holds; failed → null.
10. **Erasure and retention.** `ToolImageEraser` joins `defaultConversationDataErasers`; `UnboundToolImageRetention` joins the retention rules. The coverage test states `conversation_tool_images.message_id` (SET NULL); the export coverage test excludes the table with its reason, stated beside the exporters in `dataSubjectAccess.ts`.
11. **Test Chat.** `TrustedTestExecutionRunnerAdapter` declares `reply.blocks` (all layouts) on the replay, records the replay's `toolImages` through `ToolImagePreviewRecorder` before returning, and returns `blocks`; `TestExecutionService` puts them on `side_completed`. OpenAPI and the SDK carry `TestExecutionEvent.side_completed.blocks`.

### Migration `259_conversation_tool_images.sql`

As drafted (below), with `conversation_id` nullable (Test Chat previews), `source_object` jsonb, and checks: stored ⇒ dimensions, sha256, renditions and `stored_at`; a `url` row keeps `source_url` exactly while pending or capturing; an `inline` row has a conversation and no URL; a message implies a conversation; `capturing` ⇔ `claimed_at`. Indexes: workspace; conversation (partial); message (partial); `created_at` where unbound.

#### The drafted table

The table follows the 256 pattern: `SET LOCAL lock_timeout = '3s'`; the foreign key on `conversations` takes SHARE ROW EXCLUSIVE briefly.

| Column | Definition |
|---|---|
| `id` | `uuid` primary key, the capability id |
| `workspace_id` | foreign key, `ON DELETE CASCADE` |
| `conversation_id` | foreign key, `ON DELETE CASCADE` |
| `message_id` | foreign key to `messages`, `ON DELETE SET NULL` |
| `source_kind` | `CHECK (source_kind IN ('url', 'inline'))` |
| `source_url` | `text`, cleared once stored |
| `source_object_path` | `text`, null when `source_kind` is `url` |
| `status` | `CHECK (status IN ('pending', 'capturing', 'stored', 'failed'))` |
| `claimed_at`, `failure_reason`, `width`, `height`, `sha256` | |
| `renditions` | `jsonb NOT NULL DEFAULT '[]'` |
| `created_at`, `stored_at` | |

- **Checks:** `stored` implies dimensions and renditions; `url` implies `source_url` or `stored`.
- **Indexes:**
  - `(conversation_id)`, for erasure;
  - `(message_id) WHERE message_id IS NOT NULL`;
  - `(created_at) WHERE message_id IS NULL`, for the sweep;
  - `(workspace_id)`.

### Tests

- **Unit** (`tests/unit/chat/replyBlocks/`): `tool-records.test.ts`, `record-block-builder.test.ts`, `skill-result-envelope.test.ts`, `skill-result-gating.test.ts` (golden recorded from main before the change); the provider's `empty_answer` test now covers neither text nor records, and a new one records-only.
- **Unit**: `tests/unit/toolImages/tool-image-capture.test.ts` (capture outcomes on real encoded images, single flight, held captures, the intake), `tests/unit/externalSkills/mcp-tool-images.test.ts`, Test Chat adapter and service tests.
- **Integration**: `tests/integration/tool-result-cards.integration.test.ts` (rows, job, capture, history, erasure, sweep), plus the erasure and export coverage tests.
- **Contract**: `reply-image.contract.test.ts` copies a waiting picture on demand and answers 404 once it failed.
- **Eval**: `tests/fixtures/conversation-quality/toolCardCases.ts` (tag `tool-cards`), the stub in `scripts/evalToolCards.ts`, the deterministic half in `tests/unit/eval-suite/tool-card-cases.test.ts`; baseline entries recorded from `--tag tool-cards --samples 3` on the mini model.

### Observability, docs, contract, Ray

- **Observability:** `reply_blocks_emitted_total{layout, channel, source}` (the evidence path now labels `source="evidence"`), `reply_block_items_dropped_total{reason}` with the record reasons, `tool_image_capture_total{trigger, outcome}`, `tool_image_capture_duration_seconds{trigger}`, `tool_image_intake_dropped_total{reason}`, the `tool_images.capture` span, and `chat.reply_blocks.record_count`. Logs carry ids and error classes only.
- **Docs:** `docs/external-skills.md`, `docs-portal/content/api/agents-and-skills.mdx`, `operators/data-retention.mdx`, `operators/deleting-conversation-data.mdx`, `modules/toolImages/README.md`, the chat brief and the code map.
- **OpenAPI and SDK:** `TestExecutionEvent.side_completed.blocks`; `generate:openapi`, the SDK sync and the MCP server's `sync:openapi`.
- **Ray:** no new operation and no operator setting, so no descriptor; the image route is already `endUserSurface` (1a). Ray's `send_test_chat_message` reports the answer text, not the cards.
- **Message-queue review:** two `background_jobs` kinds; no AMQP or document-worker change. `SkillOutcome.media` holds only ids, so the approval resume journal never stores bytes.

## 4. PR 2a.2: selection on the web

### Design answers

- **`chat/services/replyBlocks/itemSelection.ts`** knows how to load an assistant message in this conversation (`MessageRepositoryPort`) and parse `storedReplyBlocksSchema` from it.
  - It requires `selection: "single"` and the key.
  - It returns a `ResolvedItemSelection {messageId, blockId, item, origin}` or a typed rejection.
  - It knows nothing of routines beyond `origin`, and nothing of channels. WhatsApp (slice 3) calls the same port with its `button_reply`.
- **`…/replyBlocks/itemSelectionTurnText.ts`** (pure) writes `<selected_item key="…">title\nsubtitle\nlink</selected_item>`, escaped, the visitor-photo pattern (`visitorImages/services/turnText.ts:6-21`).
- **Input metadata:** the method gains `item_select` and a `selection` object, added to `shared/domain/chatInputMetadata.ts` (#1759). `parseStoredInputMetadata` keeps `selection` on read.
- **Where it runs:** in `ChatService` before the session preparer stores the user message, at the point where `inputMetadata` enters (`chatSessionPreparer.ts:229`, `userMessageTurnMetadata.ts:18-25`). A rejection is a `400 item_selection_invalid` and nothing is stored. An accepted selection replaces the text with the tag and puts `TurnContext.inputEvent.itemSelection` on the turn: `{origin, item}` without the image id.
- **Frontend:**
  - `(1b) components/chat/item-list-block.tsx:170`: a `select` action renders a Select button. Choosing one calls `sendMessage(item.title, {method: "item_select", selection})` (`(1b) lib/anonymous-chat-context.tsx:768-851`), then disables the block and marks the item selected.
  - The selected state comes from later user messages' `inputMetadata.selection` in history (`lib/chat-message-mapping.ts`, 1b), with no server field.
  - A user message tagged `item_select` shows the title from its metadata.
  - Copy keys go in `lib/embed-widget.ts` and `TRANSLATABLE_COPY_KEYS` (`lib/embed-locale-packs.ts:14-45`) with every pack. Check the launcher serve fill (#1750).

### Tests first

- **Unit:** `item-selection.test.ts` (US6): accepted; unknown block, unknown key, another conversation's message, a `none` block, a non-assistant message or invalid stored metadata are all rejected. The turn text escapes `<`, `>` and quotes. The input-metadata schema requires `selection` with `item_select` and refuses it otherwise.
- **Contract:** `public-chat.contract.test.ts` (forged key → `400`, no message row) and `assistant-chat.contract.test.ts`.
- **Integration:** `item-selection.integration.test.ts`: the next turn's user message holds the tag and the metadata, and history exposes `inputMetadata.selection`.
- **Frontend:** a unit test for the request and the selected-state mapping. Playwright `reply-blocks.spec.ts` (extended): tap Select, the message shows the title, a reload shows the card selected, and other cards are disabled. Run with `PLAYWRIGHT_PORT`.
- **Live:** a 3-sample mini check that after a selection the reply treats the item as the subject (a typed judge: the answer names the selected title).

### Observability, docs, contract, Ray

- **Observability:** `reply_item_selection_total{outcome}`, with `accepted` and `rejected_{unknown_block, unknown_item, not_selectable}`; the analytics event `reply_item_selected {channel, source}`; rejections logged at info level with ids only.
- **Docs:** `docs-portal/content/api/chat-and-history.mdx` (the request, the `400`, history); `public-chat-and-embed.mdx` (the copy keys); `docs/typescript-sdk-basic-usage.md` (sending a selection).
- **OpenAPI and SDK:** `inputMetadata` on the public chat, assistant chat and history schemas (`openapi/schemas/userMessageInputMetadataSchemas.ts:28`). Regenerate as in 2a.1.
- **Ray:** the agent turn probe (`agentTurnProbe.ts:31`) keeps its three methods. Add a `fieldParity.ts` exclusion: a selection needs a stored block in a live conversation, which a probe has none of.
- **Ratchet:** `anonymous-chat-context.tsx` (1184 baselined; 1b shrinks it) and `public-chat-shell.tsx` (1208, baselined). Keep the Select wiring inside `item-list-block.tsx` and the mapping file.
- **Size:** about 30 files, +1,250 / −70. Medium.

## 5. PR 2b: routine binding and the `item` slot

### Design answers

| Module | Knows | Must not know |
|---|---|---|
| `routine-definition/src/presentBinding.ts` (new; `index.ts` is 926 lines and the consent stack adds about 20) | `present: {fromStep, selection}` inside `routineStepMetadataSchema` (`index.ts:194-198`); `captureKey` allowed on a `chat` step with `selection: "single"` (relaxing `:300-313`); `"item"` in `routineSlotTypes` (`:31`); validation codes (`:47`) | Records, blocks |
| `routines/validator.ts` (767) and new `presentBindingValidation.ts` | `present_source_not_tool`, `present_source_unreachable` (the source must reach the step through tool or action edges only, so its result is staged), `present_capture_not_item_slot`, `present_capture_missing`, `item_slot_without_presenting_step`, `item_slot_as_skill_input`, `item_slot_in_exposure`; field ops limited to `is_present` and `is_absent` (`:107-113`) | Runtime |
| `routines/compiler.ts:75-84,213-215` | Copies `present` and `captureKey` onto the engine `chat` step | |
| `conversation-contract/routineGraph.d.ts` (#1739) | `RoutineStep.present?: {fromStep, selection, captureKey?}`; `ConversationInputEvent.itemSelection?` in `replyBlocks.d.ts` (index grows by 1 line, offset by moving one more type) | |
| `conversation-engine/src/itemSelection.ts` (new) | `applyItemSelection(state, step, event)`: the current step must equal `origin.stepId` and carry `present.captureKey`. It writes `{key, title, subtitle?, link?, imageId?}` and returns `decisionTurn: true`, the `awaitingDecision.ts:40-68` pattern. Called at `routineResume.ts:98-103`. | Blocks, storage |
| `slotValue.ts:75-93` | `checkSlotValue("item")` accepts only that object shape, with bounded strings | |
| `chat/services/routines/routinePresentingStepRenderer.ts` (new) | `prepare(input)`: when `input.step.present` is set and staged context has a completed `skill_result` whose `metadata.stepId` equals `fromStep`, it renders through 2a.1's ledger, head (without `selection`) and envelope composer. The step's steering is added as rules, as `withRoutineGrounding` does (`routineGroundedAnswerRenderer.ts:61-78`). Otherwise it returns null. | MCP, rows |
| Composition | `firstPreparing([presenting, grounded])` built at `chatTurnAssembly.ts:450,672` and `approvalResumeTurn.ts:187` (offset: `chatTurnAssembly.ts` is 1482, baselined) | |

**Readers that need `item`:**
- `stepReferences.ts:15-29`, `routineEndingNotificationText.ts:46,84` and `chat/services/actions/routineEndingNoticeSummary.ts` render the title, plus the link in notices.
- `routineNextStepSelector.ts:73,325-345` leaves `item` slots out of extraction.
- `agentToolDescriptor.ts:34-44` never exposes them.
- Completion-export and action payloads send the object.
- Sensitive masking applies unchanged.
- `routine-document/src/tokens.ts:77` imports `routineSlotTypes` instead of a hard-coded list, with no growth on a baselined file.

**The editor** (Document tab only):
- `routine-document/src/block-document.ts:61-68,126-128,270-278` carries a typed `present`.
- The chip document already falls back for metadata it cannot round-trip (`document.ts:142-160,324-325`), so the prose editor needs no change.
- On a `chat` step, `routine-document-tab.tsx:303-335` (`StepEditor`) gains a compact "Show results as cards" control: source (preceding tool steps), selection (`none` or `single`), slot (`item` slots, or create one).
- `routine-document-rows.tsx:170-300` reads "Shows cards from @search → @property".
- Edits go in `lib/routine-document-edits.ts`, and slot types at `routine-document-tab.tsx:60`.

### Migration `NNN+1_routine_slot_item_type.sql`

- Drop and re-add `routine_slot_type_check` with `'item'`, under `lock_timeout 3s`; `routine_slot` is small.
- `present` lives in `routine_step.metadata` and `captureKey` in `routine_step.capture_key`, so no column changes.
- Bundles: `item` is a new enum value in agent bundles, so share the single config-version bump with the flag (§1).

### Tests first

- **Package units:**
  - `routine-definition` tests the binding schema and the `captureKey` rules.
  - `routine-document` round-trips `present`.
  - `conversation-engine`: `itemSelection.test.ts` (matching step → slot and decision turn; another step, a finished routine or an `item` value from text → no change); `slotValue` for `item`; `stepReferences` renders the title.
- **Backend units:**
  - `present-binding-validation.test.ts` (US7 scenario 6): every code.
  - `routine-presenting-step-renderer.test.ts`: the binding is honoured; a failed source or a missing stage returns null (US7 scenario 4); the step's selection overrides the model.
  - `routine-ending-notification.test.ts`: the item renders.
- **Integration:** `routine-present-select.integration.test.ts` runs US7 scenarios 1, 2, 3 and 5 against the in-memory MCP server. A scripted model gateway checks plumbing; a separate check covers behaviour.
- **Frontend:** a unit test for the edits. Playwright `routine-document-present.spec.ts`: add a chat step after a tool step, bind it, pick an `item` slot, save, and see it read back. No markup assertions.
- **Eval, mini model:** case `routine-property-flow` (tag `tool-cards`). The routine fixture is brief → `search` (the stub server) → `choose` → hand-off.
  - The case schema gains a `selectItem: {index}` turn, which resolves against the previous turn's block.
  - It asserts a `reply_block` at `choose`, `routine_slot_filled {key: "property"}`, `routine_terminal {kind: "handoff"}`, and that "the second one" leaves the slot empty.
  - Run 3 samples, and record baseline entries for this case only.
- **Ray eval:** add a copilot eval case where a presenting step is drafted from an intent ("show matches as cards and let them pick").

### Observability, docs, contract, Ray

- **Observability:**
  - `routine_present_total{outcome}`, with `presented`, `no_stage`, `source_failed` and `empty`.
  - Routine trace events `presented` (with the record count) and `item_selected` (key only), added to `frontend/lib/routine-trace-labels.ts`.
  - Validator codes reach diagnostics.
- **Docs:** `docs/authoring-routines.md`, `docs-portal/content/guides/authoring-routines.mdx` (presenting step, `item` slot, cards only on the turn the tool ran), `docs/architecture/conversational-routines.md`, code-map.
- **OpenAPI and SDK:** the routine schemas in `agentSchemas.ts` and `agentBundleSchemas.ts` change (slot type enum, step metadata). Regenerate as in 2a.1.
- **Ray:**
  - `routineStructuralPreparation.ts:32-33` uses `routineStepSchema`, so `insert_step` and `replace_step` carry the binding. That is covered by `routineStructuralPreparationNesting` (`fieldParity.ts:71-73`).
  - The `propose_routine` drafter prompt learns presenting steps.
  - `propose_routine_edit` cannot add a binding; give it a deferred exclusion like `routineCannotReworkBranching` (`fieldParity.ts:59-61`).
- **Size:** about 52 files (10 new, 28 changed, 14 tests), +2,300 / −100. Large. Commit order: extraction (contract moves, assembly offset) → definition and validator → engine → host renderer → editor.

## 6. Risks

1. **Image timing and load.** The browser requests images as soon as `done` arrives. On-demand capture then runs in the API process, about 10 third-party fetches at once with `sharp`. Signed links (Airtable lasts hours) may already be expired on a replay. Mitigations: a dedicated slot pool, a 6 s budget, and the job running at the same time. Measure p95 before turning the flag on.
2. **The `item` invariant break.** About 9 readers assume scalars (§5). A missed one shows `[object Object]` to an operator or a visitor.
3. **Prompt injection through records.** Third-party text enters the prompt as findings. The model can only point at data, never write it, but it can still be steered in its lead text. Keep the findings framing, and add an eval case with a hostile record title.
4. **Latency.** The `present` head precedes `answer` on every offered turn (1a R6), and the records add up to 3,000 input tokens.
5. **Ordering collisions:** #1772, #1775, #1759, #1739 and #1777 (migration 258), the consent renumber, and 1c's codec extraction.
6. **Test Chat cards** (1a R2). 2a.1 shows skill-result cards in Test Chat; a picture a tool returns as MCP bytes is not kept for a private test. A presenting routine (2b) gets the same once it lands.
7. **Retention of third-party data.** Titles and links persist on messages and in `routine_states.variables`; both are erased with the conversation.

## 7. Size summary

| PR | Files | Lines (+/−) | Size |
|---|---|---|---|
| 2a.0 substrate | ~16 | +650 / −380 | S |
| 2a.1 cards from skill results | ~58 | +2,700 / −90 | L |
| 2a.2 selection on the web | ~30 | +1,250 / −70 | M |
| 2b routine binding and the `item` slot | ~52 | +2,300 / −100 | L |
| **Total** | **~156** | **~+6,900** | |
