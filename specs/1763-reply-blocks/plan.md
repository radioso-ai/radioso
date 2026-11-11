# Implementation Plan: Reply blocks, slice 1 (#1763)

**Spec**: `specs/1763-reply-blocks/spec.md` (approved). **PRs**: 1a backend answer side → 1b frontend → 1c capture (after #1762 merges).
**Base**: `main` at 8fc0cd79a3. Line references are to that tree unless a branch is named.

## 0. Where the code differs from the spec

| Spec assumption | What the code says | Plan consequence |
|---|---|---|
| `buildGroundedAnswerResponseFormat` "accepts schema extensions" (D4) | It takes **one** extension (`groundedAnswerEnvelope.ts:140-166`). Directive adherence already fills it at all three call sites (`retrievalTurnSkill.ts:489,558,920`). | Add a pure `mergeAnswerSchemaExtensions(...)` to `shared/domain/answerSideChannel.ts`. Adherence's `adherencePlan` stays first in `beforeAnswer`, then `present`. |
| "Store through `DocumentStoragePort` under the document's path" (D2) | `upload()` always writes `workspaces/{ws}/documents/{documentId}` (`gcsDocumentStorage.ts:54`, `localDocumentStorage.ts:79`). Local storage cannot nest objects under a document's file. The logo route passes a synthetic leaf as `documentId` (`agentRoutes.ts:734-736`). | Objects use the leaf `document-image-{imageId}-w{320\|640}` under the workspace prefix. Rows own the paths, so per-document deletion goes through the rows; workspace erasure still finds the objects by prefix. No port change. |
| Codec "reused" from #1762 | `origin/feat/visitor-image-input:…/imageNormalizer.ts:11-16` sniffs JPEG, PNG and WebP only. `:36-42,49-80` emits one **JPEG** of at most 1,600 px and 512 KB. | 1c extracts sniff, guarded decode and EXIF strip into `shared/infra/images`, with the accepted types and the encoder as parameters. The visitor JPEG encoder and a new WebP 320/640 encoder sit on top. GIF (first frame) and AVIF are added there. |
| "The embed **and dashboard** declare the capability" | The dashboard's live chat is Test Chat (`agent-revision-test-chat.tsx`). It runs over `test-execution`, whose body has no `clientContextCapabilities` (`testExecutionRoutes.ts`) and whose completion event carries only `answer` (`test-execution/testExecution.ts:186`). | In slice 1, "dashboard" means the hosted page `/chat/[token]`, which uses the embed's provider. The conversation drawer replays stored blocks read-only. Test Chat stays text-only (risk R2). |
| Citations replay "not from the message row" | They replay from audit (`chatHistoryService.ts:1645-1668`) but are also written to `metadata_json.citations` (`chatTurnLifecycle.ts:542`). | No change. Blocks are read from the row only (D6). |
| Agent flag "following `contactRequestsEnabled`" | `handoffOnRetrievalMiss` is the closer precedent. It is a `behavior_settings` key (`agentRepository.ts:429,544`), so it needs **no migration**. A portable field must bump `AGENT_CONFIG_SCHEMA_VERSION` (`agentConfig.ts:37-46`) and `SUPPORTED_AGENT_CONFIG_VERSIONS` (`agentBundle/importService.ts:525`). | Follow `handoffOnRetrievalMiss`. Bump the version 4→5 and accept `[3, 4, 5]`. |

## 1. Cross-PR decisions

- **Migration `257_document_images.sql`.** Main ends at 253; open branches take 253 (`routine-offer-before-start`), 254 (`copilot-contributed-proposal-target-types`, `routine-consent-*`), 255 (`test-chat-talk-to-draft`) and 256 (#1762). Only 1a migrates: 1c's columns (`status`, `text_offset`, `source_etag`) are created up front. Run `pnpm run db:types` **and** `pnpm run db:schema`.
- **Table shape:**
  ```
  id uuid PK DEFAULT gen_random_uuid()   -- capability id and v1 item key (122 random bits)
  workspace_id uuid NOT NULL, document_id uuid NOT NULL REFERENCES documents ON DELETE CASCADE,
  chunk_id uuid NULL                      -- no FK: chunks are rebuilt per revision; the capture job re-anchors
  role text CHECK (role IN ('primary','inline')), status text CHECK (status IN ('pending','stored')),
  position int, text_offset int NULL, source_url text, source_etag text NULL,
  alt text NOT NULL DEFAULT '', caption text NULL, width int NULL, height int NULL, sha256 text NULL,
  renditions jsonb NOT NULL DEFAULT '[]'  -- [{width, height, bucket, objectPath, generation, sizeBytes}]
  UNIQUE (document_id, source_url); CHECK (status <> 'stored' OR (width, height, sha256 NOT NULL AND renditions <> '[]'))
  ```
  Partial indexes: `(document_id, position) WHERE status='stored' AND role='primary'` and `(chunk_id) WHERE status='stored' AND role='inline'`.
- **Image URL (revised).** The block is **persisted with the image id, not a URL**: `metadata.blocks[].items[].image = {imageId, width, height, alt}`. The wire form `{src, srcSet, width, height, alt}` is built at presentation (live response, `done`, history replay) by `ReplyImageUrls`, so a change of `APP_BASE_URL` never breaks old cards. The wire `src` is `appUrl("/backend/api/v1/public/reply-images/{id}/640", APP_BASE_URL)` (`shared/domain/appUrl.ts:10`), and `srcSet` holds the 320w and 640w URLs. This follows the public backend rule with no new environment variable; the `/backend` proxy relays headers and bytes (`frontend/app/backend/[...path]/route.ts:52-78`). This supersedes R4.
- **Head position.** `present` is generated **after** `answer` in the schema order, as a tail field, so it adds no latency before the first visible token. The model writes its lead first and picks images after. Confirm that `GroundedAnswerEnvelopeReader` parses tail extras (it finalizes the whole JSON) and that the extension merge can place a property after `answer`; if not, add that ordering to the merge helper.
- **Head fields per slice.** Slice 1's `present` head is `{ images: string[]; caption: string }` (`caption` 1-120 characters). `images` items are plain strings with **no per-turn enum**, so the schema is identical on every offered turn and stays in the provider's response-schema cache (the rule at `directiveAdherence.ts:150-157`). `selection`, `selectLabel` and `openLabel` join in slices 2 and 3, where something consumes them; `ItemListBlock` has no label fields, so slice-1 labels would be thrown away. The block carries `selection: "none"`.
- **Offer rule.** In 1a, `present` is offered only when the session declares `reply.blocks.item_list` **and** the evidence carries at least one stored image. Nothing is captured until 1c, so 1a changes no live behaviour. **The agent flag `answerImagesEnabled` moves to 1c**, where it first gates something real, and 1c adds it to the offer rule. Otherwise the prompt and the schema are byte-identical to today.

## 2. PR 1a: backend answer side

### Design answers

| Module / file | Knows | Must not know | Port it exposes (to whom) |
|---|---|---|---|
| `packages/conversation-contract/replyBlocks.d.ts` (new, re-exported from `index.d.ts`) | `ReplyBlock`, `ItemListBlock`, `ReplyItem`, `ReplyImage`, `ReplyAction`, `ReplyFact` (type only). `RenderableTurn.blocks?` | Storage, HTTP, channels | Types (chat; SDK consumers through OpenAPI) |
| `documents/contracts/documentImages.ts` + `infra/documentImageRepository.ts` (new) | `document_images` rows; stored vs pending | Chat, blocks, handles | `listStoredForEvidence({workspaceId, documentIds, chunkIds})` returns rows without storage fields (retrieval). `findServable(imageId, width)` returns a storage descriptor (image route). 1c adds the writer port. |
| `retrieval/domain/evidenceImages.ts` + `services/evidenceImageAttacher.ts` (new) | Which images belong to which evidence item: at most 1 primary per document, inline images by anchor chunk, at most 3 per item. Document title and source URL (`resolveContextSourceUrl`). | Handles, the model's pick, rendering, storage | `EvidenceImageRefReader` port (implemented structurally by the documents repository, bound in composition). `attach(workspaceId, contexts) → EvidenceWithImages[]` (chat). |
| `chat/services/replyBlocks/` (new) | The turn ledger and handles, the `present` fragment, the prompt section, block building, the layout rule, metrics | Ingestion formats, where bytes live, channel formats | `ReplyBlockTurnFactory.forTurn(session) → ReplyBlockTurn \| null` with `{schemaExtension, promptSection, build(extras)}` (`RetrievalAnswerComposer`). Depends on the attacher and on `ReplyImageUrls.forImage(id) → {src, srcSet}`. |
| `chat/contracts/replyBlocks.ts` (new) | Zod `replyBlockSchema` (`satisfies z.ZodType<ReplyBlock>`), `REPLY_BLOCK_LIMITS`, `ReplyBlocksCapability` | | History read validation. OpenAPI registers it, as it does `operatorReplySpeechSchema`. |
| `chat/contracts/clientContextCapabilities.ts` (new) | Field schemas `pageReadCapabilitySchema` and `replyBlocksCapabilitySchema` | | Replaces three copies: `publicChatRouteSchemas.ts:39-45`, `eval/suite/caseSchema.ts:124-132`, `operatorCopilot/tools/agentTurnProbe.ts:55-62`. Each caller keeps its own strictness; Ray's probe keeps `page.read` only. |
| `app/http/routes/replyImageRoutes.ts` (new) | Serving a capability id at width 320 or 640 | Documents versus conversations | Uses `ReplyImageObjectLookup` (`AppDependencies`) and `DocumentStoragePort.read` |
| `app/composition/replyBlocks.ts` (new) | Wires the attacher over the documents repository, the URL builder from `env.APP_BASE_URL`, the factory and the metrics | Product rules | |

**Dependency direction:** chat → retrieval public (attacher, types) → port ← documents repository (bound in composition); chat → conversation-contract; app/http → documents public. No domain module learns `sharp` or GCS. Checked by `cd backend && pnpm run lint` (depcruise boundaries and the architecture ratchet).

### Ledger → head → block, both paths

1. **Capability onto the session.**
   - Add `PrepareChatSessionInput.clientContextCapabilities?` (`chatSessionPreparer.ts:245-253`). Both live `prepare()` calls already spread `input` (`chatService.ts:977-983,1592-1598`), so `chatService.ts` (2229, baselined) is untouched.
   - The preparer sets `PreparedSession.replyBlocks` (`:125-135`) through a pure `replyBlocksCapabilityFromRequest` at both construction sites (`:600-618`, `:621-631`).
   - `workbenchReplayRunner.ts:404-412` adds the field to its explicit `prepareInput`, so eval cases can declare it.
2. **Ledger created.** `ReplyBlockTurnFactory.forTurn(session)` returns `null` without any query unless the offer rule holds. It runs only on the evidence branch: in `composeAnswer` before `generateGroundedAnswerEnvelope(…, "grounded")` (`retrievalTurnSkill.ts:684`), and in `streamAnswer` before `chatGateway.streamAnswer` (`:911`). The zero-evidence and page-context paths (`:636-675`, `:820-872`) never offer it.
3. **Prompt and schema.**
   - `promptWithConversationContext` (`:431-444`) takes the optional `promptSection`, rendered from `prompts/chat/answer-present-images.md` between the Results and the conversation context. A result's line reads `Result 3: [m7] (primary) · [m8] "Gentians…"`. Alt and caption lose control characters, have quotes escaped, and are capped at 120 characters.
   - `composeGroundedAnswerSystemPrompt` takes `presentHeadOffered` and appends `prompts/chat/answer-present-head.md` after the steering block, outside the reusable prefix (`groundedAnswerPromptComposer.ts:84-99`).
   - The format becomes `buildGroundedAnswerResponseFormat(mergeAnswerSchemaExtensions(sideChannel?.schemaExtension(), replyTurn?.schemaExtension))`, at `:489` (through the shared `generateGroundedAnswerEnvelope`) and at `:920`.
4. **Head parsed.** No envelope change: `present` is not a core key (`groundedAnswerEnvelope.ts:58-60`), so it lands in `extras`, non-streamed from `parseGroundedAnswerEnvelope` (`retrievalTurnSkill.ts:493`) and streamed from `GroundedAnswerEnvelopeReader.finalize()` (`:1044`). `presentHead.readPresentHead(extras)` validates it.
5. **Block built.** `replyTurn.build(extras)` runs only in the branch that ships the model's answer, where the adherence patch already resolves: `:736-741` (non-streamed) and `:1097-1102` (streamed). Blank, focused and gate-bound declines and yielded turns build none. Building drops unknown and duplicate handles, caps at 10 items, and lays out all-primary picks as `carousel`, anything else as `grid`, and any layout the client did not declare as `list`.
6. **Carried.** `ChatPresentedAnswer.blocks?` (`chatAnswerPresenter.ts:38-73`).
   - Non-streamed: the return at `:754` → `rendered` (`conversationEngineChatTurn.ts:281,313`).
   - Streamed: `TurnStreamResult.finalPresentation` (`:1116`) → `conversationEngineChatTurn.ts:407` → `chatTurnAssembly.ts:908,994`.
   - Both reach `chatTurnLifecycle`: `metadata.blocks` on the assistant message (`:496-547`) and `response.blocks` (`:1052-1075`). `toRenderableTurn` (`conversationEngineChatTurn.ts:133-151`) forwards `blocks` to the contract.
7. **Wire.** JSON: `presentChatPayload` passes `blocks`. The streamed `done` is already `...completedTurn.response` (`chatService.ts:2114-2120`). `sendChatSse` writes one `event: block` frame `{conversationId, assistantMessageId, block}` per block, then `done` with `blocks` (`chatPresenter.ts:193-221`). There is no new `ChatStreamEvent` variant: in-process channels (WhatsApp in slice 3) read `done.blocks`. The public strip passes `blocks` (`publicChatPresenter.ts:138-182,247-282`).
8. **Replay.** `historyMessageFields.replyBlockFields(message)` parses `metadata.blocks` with `replyBlockSchema` and omits it when invalid. It is spread beside `voiceMarkerFields` at `chatHistoryService.ts:1328,1406,1505`.

### Files (1a)

**New source (19):** `db/migrations/257_document_images.sql`; `documents/contracts/documentImages.ts`, `documents/infra/documentImageRepository.ts`; `conversation-contract/replyBlocks.d.ts`; `chat/contracts/{replyBlocks,clientContextCapabilities}.ts`; `retrieval/domain/evidenceImages.ts`, `retrieval/services/evidenceImageAttacher.ts`; `chat/services/replyBlocks/{turnImageLedger,presentHead,replyBlockBuilder,replyBlockTurn}.ts`; `prompts/chat/answer-present-{head,images}.md`; `app/composition/replyBlocks.ts`; `app/http/routes/replyImageRoutes.ts`; `app/http/openapi/paths/replyImagePaths.ts`, `app/http/openapi/schemas/replyBlockSchemas.ts`.

**Extraction-only commit first (8 new)**: see the offset table.

**Changed, chat and runtime (17):** `shared/domain/answerSideChannel.ts`; chat services `groundedAnswerPromptComposer.ts`, `retrievalTurnSkill.ts`, `chatAnswerPresenter.ts`, `chatTurnRuntime.ts` (`:100-118`, optional `replyBlocks` dependency), `conversationEngineChatTurn.ts`, `chatTurnLifecycle.ts`, `chatHistoryService.ts` (type at `:249`), `chatSessionPreparer.ts`, `workbenchReplayRunner.ts` (result at `:869-885`); `chat/types/{chatResponses,assistantApi}.ts`; `chat/contracts/streamEvents.ts` (`done.blocks?`), `chat/contracts/index.ts`; `retrieval/public.ts`, `documents/public.ts`; `conversation-contract/index.d.ts`.

**Changed, HTTP and composition (10):** `app/server/builders/{chat.ts:505-515,infra.ts}`, `app/server/types.ts`; `app/http/routes/index.ts` (mount `/api/v1/public/reply-images`), `publicChatRouteSchemas.ts`; `presenters/chatPresenter.ts`; `openapi/schemas/assistantHistorySchemas.ts` (`blocks` on `chatResponseCoreShape` at `:191` and on the message shape at `:672-687`); `openapi/paths/assistantPaths.ts:7-21` (SSE order: "…chunk events, block (one per reply block), done…"); `openapi/{openApiRegistry,openApiPaths}.ts`.

**Moved to 1c: agent flag (9):** `agents/domain.ts`; `agents/agentInputSchema.ts:35,124` (Ray reviewed patch at `:115-136`); `agents/agentConfig.ts:46,153,695,814,901`; `db/repositories/agentRepository.ts`; `routes/agentRoutes.ts:98`; `openapi/schemas/agentSchemas.ts:168,239`, `agentBundleSchemas.ts:185,362`; `agentBundle/importProjection.ts:90`, `importService.ts:525`.

**Changed, eval, Ray and SDK (13):** `eval/suite/{caseSchema,traceAssertions,observedOutput}.ts`; `scripts/{evalRunnerAdapter,evalRunnerSupport}.ts` (seed fixture `document_images` rows once the corpus is processed; inline rows take the first chunk's id); `tests/fixtures/conversation-quality/{index,corpus,agent}.ts`, `baseline.json`, and new `replyBlockCases.ts`; `tests/unit/operatorCopilot/fieldParity.ts:178,259`, `catalogCoverage.ts:574-578` (`getPublicReplyImage` joins `endUserSurface`); `typescript-sdk/src/streaming/chatStream.ts` (`block` event).

**Generated:** `db/schema.sql`, `shared/infra/kysely/schema.ts`; `typescript-sdk/openapi/` and `src/generated/`; the MCP server snapshot; the product-docs corpus.

**Docs: 7** (below).

### Baselined and near-limit files (ratchet: no baselined file grows; no new file over 1,000 lines)

| File | Lines | 1a adds | Offset (extraction-only commit) |
|---|---|---|---|
| `chat/services/retrievalTurnSkill.ts` | 1160 (b) | ~14 | Move the five `record*` metric methods (`:245-386`, leaving `sideChannel` and `zeroEvidenceDeclineReason`) to `groundingOutcomeMetrics.ts` |
| `chat/services/chatTurnLifecycle.ts` | 1536 (b) | ~3 | Move the audit builders (`:1400-1512`) to `assistantTurnAuditEvents.ts` |
| `chat/services/chatHistoryService.ts` | 1670 (b) | ~4 | Move `voiceMarkerFields` (`:295-298`) and `messageMetadataSuggestions` (`:716-726`) to `historyMessageFields.ts` |
| `chat/services/chatSessionPreparer.ts` | 1366 (b) | ~5 | Move `isEligibleForFacetExtraction` (`:108`) and `enqueueFacetExtraction` (`:766`) to `facetExtractionEligibility.ts` |
| `app/server/builders/chat.ts` | 1039 (b) | ~2 | Move `buildMcpConverseServices` (`:169-205`) to `builders/mcpConverse.ts` |
| `openapi/schemas/assistantHistorySchemas.ts` | 1044 (b) | ~3 | Move the message shape and its two registrations to `chatConversationMessageSchemas.ts` |
| `db/repositories/agentRepository.ts` | 1295 (b) | ~2 | Move `toBehaviorSettings` (`:422-436`) and the behaviour reads (`:536-548`) to `agentBehaviorSettingsRow.ts` |
| `conversation-contract/index.d.ts` | 2169 (b) | ~2 | Move `RenderableTurn` and `PendingRenderableTurn` (`:627-657`) to `renderableTurn.d.ts` |
| `agents/domain.ts` | 997; **1000 on #1762** | ~2 | If #1762 lands first, move the defaults block (`:63-75`) to `agentDefaults.ts` |
| `app/http/routes/publicChatRoutes.ts` | 978; 991 on #1762 | 0 | The image route gets its own router |

Re-record the baseline with `pnpm run lint:file-size:baseline` after the extraction commit. Its existing focused tests must stay green unchanged.

### Failing tests first (TDD)

**Unit (`backend/tests/unit/`)**
- `chat/replyBlocks/turnImageLedger.test.ts`:
  - handles `m1..` in evidence order, primary before inline;
  - sha256 dedupe and the 24-handle cap;
  - section escaping: alt text with newlines, `"`, or "ignore previous…" stays one quoted line.
- `chat/replyBlocks/presentHead.test.ts`: the fragment sits in `beforeAnswer`, is strict, and has no item `enum`; malformed extras are rejected.
- `chat/replyBlocks/replyBlockBuilder.test.ts` (spec scenarios 1-2 and the edge cases):
  - an unknown handle is dropped and counted as `unknown_handle`; a URL given in place of a handle is dropped;
  - an empty pick builds no block;
  - picks keep the model's order and are capped at 10;
  - the layout rules hold;
  - title: document title for a primary image; for an inline one, caption, then alt, then document title;
  - the link is set only for http(s) URLs;
  - `src` and `srcSet` come from the port only.
- `shared/answer-side-channel-merge.test.ts`: `merge(a, null)` returns the same object; key order is adherence, then present.
- `retrieval/evidenceImageAttacher.test.ts`: at most one primary per document; inline images by chunk; the per-item cap; title and URL.
- `chat/reply-blocks-composer.test.ts`: `composeAnswer` and `streamAnswer` both return `blocks` from a scripted `present`; declines, yields and gate-bound turns return none.
- **Gating regression (byte-for-byte):** `chat/reply-blocks-capability-gating.test.ts`.
  - Record `{systemPrompt, prompt, responseFormat}` from the gateway on unchanged main as a golden fixture.
  - Assert `toStrictEqual` and `JSON.stringify` equality for (a) no capability, (b) capability with the flag off, (c) both on with no stored images.
  - Assert the evidence reader is **not called** in (a) and (b).
- Wire and storage:
  - `chat-presenter.test.ts`: `block` frames come before `done`; `done.blocks`.
  - `chat-history-service.test.ts`: replay from metadata; invalid metadata is ignored.
- Flag and contracts:
  - `agent-config-serializer.test.ts`: the v5 round trip.
  - `agent-routes-schema.test.ts`.
  - The public route schema accepts `reply.blocks` and strips unknown layouts.
  - The eval suite's deterministic `reply_block` assertion.
  - The SDK's `block` parse.

**Integration**
- `document-image-repository.integration.test.ts`: stored-only reads, workspace scoping, cascade.
- `chat/reply-blocks-persistence.integration.test.ts` (scenario 1): a scripted present head persists `metadata_json.blocks`, and history returns the identical block.

**Contract**
- `public-chat.contract.test.ts`: the SSE order is `chunk…`, `block`, `done{blocks}`, `suggestions`.
- New `reply-image.contract.test.ts`:
  - `200` with `image/webp`, `nosniff`, `Cache-Control: private, max-age=300` and `Cross-Origin-Resource-Policy: cross-origin`;
  - `404` for unknown, pending or deleted rows and for any width other than 320 and 640 (scenario 5, backend half).
- `openapi-route-coverage.contract.test.ts` covers the new route by itself.

**Scenario / live eval** (business behaviour; mini model only)
- `replyBlockCases.ts` (tag `reply-blocks`):
  - "Which hiking books do you have?" over five invented `shop.example` product documents with primary images. Asserts `reply_block {layout:"carousel", minItems:2, itemsFromEvidence:true}` and `answer_excludes_image_url`.
  - "What does the guest house look like?" over one `stay.example` page with inline images. Asserts `reply_block {layout:"grid"}`.
- The gating cases run in the deterministic harness only.
- Run `pnpm run evals -- --tag reply-blocks --samples 3` and record baseline entries for these cases only. Ask before any full-suite run.

### Observability

- `reply_blocks_emitted_total{layout, channel}`, where `channel` is the conversation's bounded `sourceChannel`.
- `reply_block_items_dropped_total{reason}`: `unknown_handle`, `duplicate_handle` or `over_limit`.
- No new span: the evidence read is one indexed query inside the compose span, which gains the attribute `chat.reply_blocks.ledger_size`.
- The head's extra tokens show in the existing `coverageHeadMs` and first-chunk latency.
- The image route adds no metric, because the HTTP metrics cover it. A 404 is the normal state after a deletion and is not logged.
- No URL, alt text or handle reaches a log or a label.

### Docs and READMEs (reference register per `docs/document-writer-prompt.md`)

- `docs-portal/content/api/chat-and-history.mdx`:
  - `blocks` on the response and on history;
  - the `block` event in "Streaming and non-streaming modes" (`:56-76`);
  - a card shows no picture once its document is deleted.
- `docs-portal/content/api/public-chat-and-embed.mdx`: `clientContextCapabilities["reply.blocks"]` and `answerImagesEnabled`.
- `docs/typescript-sdk-basic-usage.md:417-440`: the `block` event.
- READMEs: `modules/chat/README.md`, `modules/retrieval/README.md`, `modules/documents/README.md`.
- `docs/architecture/code-map.md`: Chat And Assistant, Retrieval, Documents And Ingestion, Conversation Engine Contracts, Backend HTTP Surface, and Conversation-Quality Eval Suite.
- `readme.md` stays unchanged: no setup, auth or ingestion setting changes.

### Contract, SDK and lint steps

- `cd backend && pnpm run db:types && pnpm run db:schema && pnpm run generate:openapi`
- `cd typescript-sdk && pnpm run sync`
- `cd packages/radioso-mcp-server && pnpm run sync:openapi`
- `cd packages/product-docs && pnpm run sync`
- Then:
  - `pnpm run lint`, `lint:dead-code:ci` and `lint:file-size`;
  - `cd backend && pnpm run lint`;
  - `tsc` on the runtime and test configs;
  - `test:unit`, `test:contract` and `test:integration`.
- **Message-queue review:** no worker or queue payload changes in 1a.

## 3. PR 1b: frontend

### Design answers

- **`frontend/components/chat/item-list-block.tsx` (new)** renders `item_list` as `carousel` (scroll-snap cards), `grid` (two-column gallery) or `list` (also the fallback for an unknown layout), with the `open` action. It knows nothing of where images come from or of selection (slice 2).
  - Each card is one link whose name is the item title. The carousel is a region labelled with the block `caption`.
  - There are no new copy keys: no Previous/Next buttons, because native scrolling is enough.
  - Images are `<img loading="lazy" srcSet sizes width height alt>` and hide themselves on error (scenario 5).
  - Links go through the thread's `transformAssistantLinkHref` (UTM) and its existing link analytics.
  - It uses `packages/ui` primitives and Lucide `ExternalLink`, styled with the embed theme tokens.
- **`frontend/lib/reply-blocks-capability.ts` (new)** owns the declaration `{"reply.blocks":{item_list:{layouts:["carousel","grid"]}}}`. The provider merges it with the host's `page.read` once, at the prop (`anonymous-chat-context.tsx:342`). That covers both the embed and the hosted `/chat/[token]`.
- **Data path:**
  - `api-chat-stream.ts:65-165` parses `block` (accumulator plus `onBlock`); `done.blocks` wins.
  - `ChatStreamHandlers.onBlock` and `ChatStreamCompletion.blocks` are added (`api-types.ts:404-416,618-625`).
  - `ClientContextCapabilities` (`:285-291`) becomes the generated `PublicChatRequest["clientContextCapabilities"]`.
  - `ChatMessage.blocks` (`anonymous-chat-context.tsx:96-121`) is filled by `toChatMessagesFromTurns` (`:218-244`) and `applyCompletion` (`:759-800`); the suppressed human-owned branch clears it.
  - `ChatThreadMessage.blocks` (`chat-message-thread.tsx:112-137`) renders under `AssistantMessageContent` (`:850-873`).
  - The shell needs no change: `visibleMessages` spreads each message (`public-chat-shell.tsx:609-620`).
  - The drawer and the Inbox show blocks read-only if their mappings spread messages. Anything more is slice 2.
- **Relay: no change.**
  - The request forwards `clientContextCapabilities` opaquely (`app/api/public/chat/[token]/route.ts:37-47`), and the body streams raw (`:70-73`).
  - Images load through `/backend/[...path]`.
  - CSP `img-src` allows `'self' https:` (`next.config.mjs:14`).
  - The embed sanitizer (`embedded-chat-frame.tsx:128-152`) stays host-only.

### Files

- **New:** `item-list-block.tsx`, `reply-blocks-capability.ts`, `lib/chat-message-mapping.ts` (offset), `components/chat/voice-markers.tsx` (offset).
- **Changed:**
  - `anonymous-chat-context.tsx`, `chat-message-thread.tsx`, `api-chat-stream.ts`, `api-types.ts`, `embedded-chat-frame.tsx` (type only);
  - `components/dashboard/README.md`, `lib/README.md`;
  - docs.
- **Offsets:**
  - `chat-message-thread.tsx` (1135, baselined): move `SpokenMarker`, `InterruptedReplyBadge` and `OperatorReplySpeechBadge` (`:139-195`) to `voice-markers.tsx`.
  - `anonymous-chat-context.tsx` (1317, baselined): move `toChatMessagesFromTurns` and its helpers (`:192-244`) to `chat-message-mapping.ts`.

### Tests

- **Unit:**
  - `api-chat-stream.test.ts`: `block`, then `done`.
  - `anonymous-chat-*.test.tsx`: the request carries both capabilities, history keeps blocks, the completion sets them.
  - A pure `resolveReplyLayout` test.
  - No markup or CSS assertions.
- **Playwright:** new `frontend/tests/e2e/reply-blocks.spec.ts`, stubbing SSE and history as `privacy-notice.spec.ts` does. On the hosted page:
  - a carousel of three titled cards appears;
  - a card opens its page in a new tab;
  - a reload shows the same cards;
  - a 404 image leaves the card without a picture;
  - a `grid` block renders a gallery.

  Run with `PLAYWRIGHT_PORT`.

### Docs

- `docs-portal/content/guides/publish-an-agent.mdx`: a "Picture cards" section with the screenshot `dashboard-embed-picture-cards.png`.
- `public-chat-and-embed.mdx`: the embed declares the capability.
- Re-sync product-docs.

## 4. PR 1c: capture (after #1762 merges)

This PR also adds the agent flag `answerImagesEnabled` (default off) to the offer rule. It uses the nine files listed under 1a's "Moved to 1c", the config version bump, and the Ray agent-settings descriptor. The image route also gets a per-source rate limit here, reusing an existing public limiter; if none fits, record that as a risk rather than building new infrastructure.

| Part | Knows | Must not know |
|---|---|---|
| `packages/crawler/src/transport/htmlImageExtraction.ts` (new) | `og:image`, `twitter:image` and JSON-LD `image` from `<head>` (`htmlProcessing.ts`). Main-container `<img src/srcset alt>` and `<figure>`/`<figcaption>` with their offset in the extracted text (`htmlContentExtraction.ts`). Absolute URLs; `data:` and SVG refused. Output: `CrawledPageResult.images?` | Fetching, storage |
| `websiteCrawler` | Maps `page.images` → `WebsiteCrawlPage.images` (`radiosoCrawlerProvider.ts:236-257`, `provider.ts:18-24`) and passes them to `ingest` (`service.ts:33-60`, 972 lines; at most +2). The metadata allowlist (`:739-748`) is untouched. | Bytes |
| WordPress | REST: `featured_media` plus `_embedded["wp:featuredmedia"]` through `_embed` (`wordpressClient.ts:28-29`). Companion: an optional `featured_image: {url, alt}` (`radioso-sync.php:1044-1095`, with a version bump). Both map to one primary candidate (`wordpressIngest.ts:104-130`). | Bytes |
| `documents` ingestion | `DocumentIngestionPort.ingest({images?})` (`contracts/index.ts:61-77`) diffs against rows by `source_url` inside the upsert transaction: new candidates go in `pending`, removed ones are marked for deletion (`DocumentImageWriterPort`). | Chat |
| `documents/services/documentImageCaptureService.ts` (new) | Fetch, then codec, then filters (short side under 200 px → `too_small`, URL dedupe, keep 12), then store, then mark `stored`. Re-anchoring maps `text_offset` to the chunk whose `[start_offset, end_offset)` contains it (`chunkRepository.ts:32,85`), falling back to a nearby snippet, then to no chunk. Deletes the objects of removed rows. A failed image never fails the job. | Chat, blocks |
| `shared/infra/images/` (extracted from #1762) | Sniffing (adds GIF first frame and AVIF; refuses SVG), decode under the pixel cap, EXIF strip, `encodeJpegUnder` (visitor images) and `encodeWebpRenditions([320, 640])`. `visitorImages/…/imageNormalizer.ts` delegates to them. | Who owns the image |
| `shared/infra/http/publicBytesFetch.ts` (new) | `fetchPublicUrl` (`publicUrlFetch.ts:60-83`; the dispatcher re-checks every redirect) plus `AbortSignal.timeout`, a streaming byte cap, and `If-None-Match` | Images |

- **Job.** A new kind, `images`, is enqueued after vectorize publishes chunks, at lower priority, like `enrich` (`documentProcessingJobRepository.ts:448`). It is dispatched at `documentProcessingWorker.ts:409-413`.
- **Message-queue review.**
  - The payload stays `{jobId}` (`documentJobMessage.ts`); the kind comes from the row.
  - Retries match `enrich`.
  - The claim index already covers `kind`.
  - `documentProcessingJobRepository.ts` is 1156 lines and baselined: generalise the enrich enqueue to take a kind rather than adding a method.
- **Deletion.** `documentDeletionService.ts:84-96` reads the image renditions first and deletes the objects best-effort. A workspace erasure sweeps the prefix.
- **Document detail.**
  - `getDocument` gains `images?`. There is no new operation, so the coverage map holds. The schema goes in a documents schema file, because `documentsPaths.ts` is 1035 lines and baselined.
  - Ray's `document_search` (`catalogCoverage.ts:30`) maps an `imageCount`.
  - New `frontend/components/dashboard/documents/document-images-list.tsx`, mounted in `documents-view.tsx` (1263, baselined; offset by extracting one panel).
- **Tests first.**
  - Crawler fixture (story 2, scenario 1): one primary and two inline images with offsets; the 1×1 pixel is refused after decode.
  - Codec: magic-byte table; SVG and polyglots refused; pixel cap; WebP output without EXIF.
  - `publicBytesFetch`: timeout, byte cap, private address, private redirect, 304.
  - Capture outcomes: `stored`, `reused`, `too_small`, `unsupported_type`, `too_large`, `blocked_address`, `timeout`, `decode_error`.
  - Re-sync: a removed image loses its row and object (scenario 4).
  - All images fail and the document still completes (scenario 3).
  - Integration: a WordPress featured image becomes the primary, over REST and over the webhook (scenario 2).
  - Playwright: the images list appears in document detail (scenario 5).
- **Observability.**
  - `document_image_capture_total{source, outcome}`, with `source` one of `crawler_metadata`, `crawler_inline` or `wordpress_featured`.
  - `document_image_capture_duration_seconds`.
  - The span `document.images.capture` under `document.worker.job`.
  - Logs carry ids only.
- **Docs.**
  - `docs/website-crawler.md`.
  - `docs-portal/content/operators/{document-processing,wordpress-connector,data-retention}.mdx`.
  - `architecture/document-processing-lifecycle.mdx`.
  - `packages/wordpress-companion/README.md`.
  - The `documents` and `visitorImages` READMEs.
  - code-map: Documents, Website Crawler, `shared/infra/images`.

## 5. Open risks

- **R1. File count.** 1a touches about 105 files (about 90 before counting new test files):

  | Group | Files |
  |---|---|
  | Feature core | 19 new + 27 changed |
  | One boolean flag | 9 |
  | Ratchet offsets | 8 |
  | Eval, Ray and SDK | 13 |
  | Generated | about 8 |
  | Docs | 7 |
  | New tests | about 15 |

  The flag cost is a substrate smell: there is no single agent-field registry, so each flag is restated in the domain, input schema, config, repository, routes, OpenAPI and bundle. Recommendation: land the extraction commit as its own PR (1a.0) first.
- **R2. Test Chat shows no cards.** It carries neither capabilities nor blocks. Slice 1 also has no dashboard toggle: only Ray and the API set `answerImagesEnabled`. Confirm this is acceptable.
- **R3. #1762 overlap.**
  - #1762 adds `visitorImagesEnabled` without a version bump (`origin/feat/visitor-image-input:…/agentConfig.ts:46`). Whichever PR lands second makes sure a single bump to 5 covers both fields.
  - #1762 brings `agents/domain.ts` to exactly 1,000 lines.
- **R4. Persisted absolute `src`. Resolved: the block persists the image id (§1).**
  - Changing `APP_BASE_URL` breaks old cards' images, as it breaks emailed links.
  - A self-hosted install without `APP_BASE_URL` stores `localhost:3000` URLs.
- **R5. Answer layout.** "Do not enumerate presented items" conflicts with #1733's three-or-more-items-as-a-list rule. The present-head prompt must state which wins; watch the eval for duplicated lists.
- **R6. Latency.** `present` precedes `answer`, so the first visible token comes later on offered turns.
- **R7. Anchoring.** Offset anchoring assumes the processed text equals the crawled text. The snippet fallback limits the damage.
- **R8. Unauthenticated binary route.** There is no per-route limiter (the logo route has none either). Ids carry 122 random bits, and the lookup is one row by primary key.
- **R9. Ingestion cost.** Images are captured for every document, up to 12 per page. The worker's `sharp` needs `concurrency(1)`. Load-test a 1,000-page crawl before 1c merges.
