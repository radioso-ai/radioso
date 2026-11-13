# Feature Specification: Reply blocks — image cards from the content an answer uses

**Feature Branch**: `feat/reply-blocks-image-cards`
**Created**: 2026-11-11
**Status**: Draft
**Issue**: #1763
**Input**: Show pictures in the chat as cards a visitor can open or pick from, not a paragraph with links. Define a generic structured block on assistant messages and build its first kind, an image list. The images come from the content the agent already answers from:
- image links in a page or document;
- images named in metadata (a page's `og:image`, a WordPress featured image);
- images embedded in a document.

Later, a connector that fetches content live supplies images the same way, and the response is checked against them. The block works on the website embed and on WhatsApp.

An item is not a product. The block carries a product's cover, a gallery photo, or later a bill-of-materials row, with the same shape.

**Decided 2026-11-11**:
- `sharp` is accepted.
- WhatsApp is in scope.
- Prices and other facts are out of scope for now.
- Images taken from live tool results are deleted with their conversation.
- The design is shared with visitor image input (`specs/visitor-image-input/`).

## Why this exists

- **Ingestion drops every image.**
  - The crawler extracts text only (`packages/crawler/src/transport/htmlContentExtraction.ts`). Page metadata passes a fixed allowlist with no image key (`backend/src/modules/websiteCrawler/service.ts:739-748`).
  - The WordPress companion pushes price, SKU and stock but no featured image (`packages/wordpress-companion/radioso-sync.php:1044-1095`). The REST sync requests no `featured_media` (`backend/src/modules/connectors/plugins/wordpress/wordpressClient.ts:28-29`).
  - The DOCX, PDF and markdown parsers emit text only (`packages/document-parser/parsers/`).
- **Document metadata cannot hold a list of images.** It is a flat map of scalars capped at 16 KB (`backend/src/modules/documents/domain/documentMetadata.ts:11-18`).
- **The chat cannot show a picture.** Markdown `img` renders `null` outside the document variant (`frontend/components/markdown/markdown-content.tsx:279-282`). That is the right rule, because a model-written image URL is unverifiable.
- **An assistant message carries text plus three structured parts:** citations, suggestions and ownership (`backend/src/modules/chat/types/chatResponses.ts:62-103`). Citations and suggestions replay from the `chat.answer` audit event (`chatHistoryService.ts:1645-1668`), not from the message row.
- **The grounded answer is already structured output with a head before the text.** The coverage head (`backend/prompts/chat/answer-coverage-head.md`) is built by `buildGroundedAnswerResponseFormat` (`backend/src/modules/chat/services/groundedAnswerEnvelope.ts:140`), which accepts schema extensions. A `present` head fits beside it.

## Decisions

### D1. Semantic blocks built from shared primitives, not a layout tree

A reply block is a typed, closed union discriminated by `type`. Each kind is a semantic template: an image list now, later an item detail, choices or a form. Each kind is built from a few shared primitives: text, image, link and action, and later typed facts.

A free-form layout tree (Adaptive Cards style) was rejected for three reasons:
- It has no channel fallback. A semantic kind maps to a WhatsApp carousel; an arbitrary layout maps to nothing.
- It hands layout to the model or the tool.
- Every nesting level is renderer surface that must be tested on every channel.

Tool-provided UI (MCP Apps / OpenAI Apps SDK `ui://` iframes) was rejected because it runs third-party markup in the visitor's chat and has no channel fallback.

### D2. Images are captured with the content, at ingestion

The document worker captures images while it processes a document. Document processing is already asynchronous, so a turn never waits on an image fetch.

| Form in the content | Where it is found | Role |
|---|---|---|
| Metadata image | Crawler: `og:image`, `twitter:image`, JSON-LD `image`. WordPress: the featured image (companion field, REST `featured_media`). | `primary` for the document |
| Linked image | Crawler: `<img src/srcset alt>` and `<figure>`/`<figcaption>` inside the extracted main container. Markdown: `![alt](url)`. WordPress post HTML. | `inline`, anchored where it appears |
| Embedded image | Bytes inside the document: DOCX `word/media`, HTML `data:` URIs, PDF image objects | `inline`, anchored where it appears |

For each captured image:
- **Anchoring:** an inline image is tied to the chunk whose text surrounds it, and keeps its alt text and caption. Stored chunk text and embeddings do not change beyond alt or caption text that is already page content.
- **Fetch:** a linked or metadata image is fetched through `fetchPublicUrl` (`backend/src/shared/infra/http/publicUrlFetch.ts`), with a timeout and a byte cap added. That helper accepts public addresses only and re-validates every redirect. An embedded image is read from the document bytes.
- **Validate and encode:** shared with visitor image input, through the image codec.
  - The type is sniffed from magic bytes: JPEG, PNG, WebP, GIF (first frame) or AVIF. SVG is refused.
  - The image is decoded with `sharp` under a pixel cap.
  - It is re-encoded to WebP at 320 and 640 wide, which strips EXIF and GPS and defuses polyglots.
- **Filter** (structural rules, not vocabulary):
  - Images under 200 px on the short side are skipped. That removes icons, spacers and tracking pixels.
  - Images are deduplicated by source URL within the document.
  - At most 12 are kept per document.
- **Store** through `DocumentStoragePort` under the document's path. Rows go in `document_images`: document, chunk, role, alt, caption, source URL, dimensions, sha256 and the storage descriptor. The rows cascade with the document.
- **Re-sync:**
  - An unchanged source URL with an unchanged ETag is reused.
  - An image that is no longer in the content is deleted.
  - A failed image never fails the document.
- **Lifetime: the document's.** Deleting or re-syncing a document deletes its images. A card in an older conversation then renders without its picture. A document image is shared by every conversation that shows it, so it is not copied per conversation.

Images are captured for every document whether or not any agent shows them, so turning the feature on needs no re-sync.

### D3. Radioso serves its own copy; the block holds a media reference

| | Remote URL in the visitor's browser | Bytes sent inside the block | **Radioso copy (chosen)** |
|---|---|---|---|
| Visitor privacy | IP and UA go to whatever host the content names | Fine | Fine |
| Integrity | The source can change the image after the answer | Stable | Stable while the content exists |
| Payload | Originals (one reference site serves 1400w covers) | base64 in every row, SSE frame and SDK payload | 320w/640w WebP, cached |
| Safety | Tracking pixels; mixed content; hotlink protection | Bloat only | Sniffed, re-encoded, SVG refused |
| WhatsApp | Meta must fetch a stable URL | Unusable | Stable HTTPS URL |

**The block carries `image.src` as an opaque URL plus `width`, `height` and `alt`.** Document images, images from live tool results (later) and operator uploads all end up as stored copies. Clients never learn which source an image came from.

**Serving:**
- The URL is a capability with an unguessable id and needs no session cookie. The embed loads it cross-origin, and Meta's servers fetch it for WhatsApp.
- Responses carry `nosniff`, a forced `image/webp` type and `Cache-Control: private`, so that no shared cache outlives a deletion.
- Showing an image is the same exposure as quoting its document, which the answer already does.

### D4. The model chooses; the host builds the block and checks every reference

The answer's evidence already carries chunks and documents. Each evidence item now also carries its images, as short handles in the prompt:

```
[3] A Field Guide to Alpine Flowers — https://shop.example/books/alpine-flowers
    Images: [m7] (primary) · [m8] "Gentians on the ridge above the village"
```

The grounded answer's `present` head returns what to show:

```ts
{ images: string[]; selection: "none" | "single"; caption: string; selectLabel?: string; openLabel?: string }
```
- `images` are handles, in display order.
- `caption` is up to 120 characters.
- The labels are up to 20 characters, for WhatsApp only.

The host builds the block from the handles. It does not use any model-written URL or title.
- **Unknown handles** are dropped, and an empty pick builds no block.
- **Each item** is built from its image:
  - key: the image id;
  - title: the document title for a `primary` image, otherwise its caption or alt text;
  - link: the document's source URL when it is http(s);
  - image: the stored copy.
- **Layout** is derived, not chosen. Primary images of several documents form a `carousel` of cards. Inline images form a `grid` gallery.
- **The answer text** does not enumerate presented items. This interacts with the list layout in #1733.

**Live content (a later slice).** A connector or tool that fetches content at turn time adds its image URLs to the same ledger. The rule is the one the user named: the response can only show an image that the given content contained. A URL qualifies only if it appears in that turn's tool output, the same provenance idea as the link guard for #1751 (PR #1760). Those images are fetched at turn time and stored per conversation, and are deleted with it.

### D5. Rendering is a channel capability

The public chat body already carries `clientContextCapabilities` (`backend/src/app/http/routes/publicChatRouteSchemas.ts:39`).
- **Web:** a client that renders blocks declares `"reply.blocks": { item_list: { layouts: ["carousel", "grid"] } }`.
- **Server-side channels** declare the capability in their adapter. WhatsApp declares it. Slack, email, voice, A2A and MCP ask declare nothing.
- **Without the capability**, the schema offers no `present` head, and the reply is text as today.
- **No deterministic text fallback** is generated, so user-facing copy stays the model's.

### D6. Blocks persist on the assistant message row

A block is a snapshot of what the visitor saw, stored in `messages.metadata_json.blocks`, not in the audit stream. It replays from history whatever the audit retention.

### D7. WhatsApp renders the same block with Cloud API interactive messages

The connector sends text only today (`backend/src/modules/connectors/plugins/whatsapp/whatsappClient.ts:46-50`) and reads only inbound `text` (`whatsappMessageHandler.ts:321`). Meta's limits are quoted from the Cloud API docs, as read 2026-11-11:
- **Carousel:** 2–10 cards. Each card needs an image or video header. Card body up to 160 characters. Each card has either one URL button or quick-reply buttons, and every card has the same buttons. Button labels are up to 20 characters. Message body is required, up to 1,024 characters. Static WebP is accepted.
- **Reply buttons:** up to 3, with an optional image header.
- **List:** up to 10 rows.

| Block | WhatsApp message |
|---|---|
| Selectable, 2–10 items | Carousel, one quick-reply button per card (`selectLabel`) |
| Not selectable, 2–10 items, all with a link | Carousel, one URL button per card (`openLabel`) |
| Not selectable, some items without a link (a gallery) | Up to 4 image messages, each captioned with its title |
| 1 item | Image message (not selectable) or a reply-button message with an image header (selectable) |

**Rules:**
- **Text:** the model's reply text goes in the carousel body when it fits. Otherwise it is sent as its own message, and the body is the `caption`.
- **Tap inbound:** a `button_reply` arrives with an id of up to 256 characters that encodes `(blockId, itemKey)`. It is resolved against the stored block in that conversation and becomes the same `item_select` input as the web. An unresolved id is treated as unrecognised input.
- **Window:** all of these are replies inside the 24-hour customer-service window.
- **Unknown:** Meta does not document the webhook for a carousel quick-reply tap. The WhatsApp slice starts with a live check on Meta's free developer test number.

### Naming

"Widget" already names the embed launcher and panel. In code and API this is a **reply block**; the first kind is `item_list`. In UI copy it is **cards**.

## Contract

```ts
type ReplyBlock = ItemListBlock; // later: item_detail | choices | form

interface ItemListBlock {
  type: "item_list";
  id: string;                      // unique within the message
  layout: "carousel" | "grid" | "list"; // later: "table" (bill of materials)
  selection: "none" | "single";
  caption: string;                 // model-written, ≤120; accessible label; WhatsApp body fallback
  items: ReplyItem[];              // 1..10
}

interface ReplyItem {
  key: string;                     // stable id of the item's source (v1: the image id)
  title: string;                   // plain text, ≤160, from the content
  description?: string;            // plain text, ≤400 (v1: unused)
  image?: ReplyImage;
  facts?: ReplyFact[];             // designed, not shipped in v1: labelled text, number+unit, money, date
  actions: ReplyAction[];          // open when the item has a link; select when selection = single
}

interface ReplyImage { src: string; alt: string; width: number; height: number; srcSet?: string }
type ReplyAction = { type: "open"; url: string } | { type: "select" };
```

A client renders an unknown `layout` as `list`. The server never sends a block `type` the client did not declare.

Wire changes:
- **Turn response and history:** `ChatResponse.blocks?`, and `ChatConversationMessage.blocks?` / `PublicChatConversationMessage.blocks?`.
- **Stream:** a `block` SSE event before `done`, and `done.blocks`.
- **Request:** `inputMetadata.method = "item_select"` with `selection: { messageId, blockId, itemKey }` (slice 2).
- **Contract regeneration:** OpenAPI, then the SDK snapshot (`cd typescript-sdk && pnpm run sync`).

## Boundaries (what each part knows)

| Part | Knows | Must not know |
|------|-------|---------------|
| `packages/conversation-contract` | `ReplyBlock`, `ReplyItem`, the primitives; `RenderableTurn.blocks?` | Storage, HTTP, channels |
| `packages/crawler`, `packages/document-parser`, the WordPress connector | Finding image references and embedded image bytes in their format, with alt, caption and position | Fetching, storage, chat |
| `backend/src/modules/documents` (document images) | Capturing, filtering and storing a document's images in the worker; the `document_images` rows; lifetime with the document | Chat, blocks, channels |
| `backend/src/shared/infra/images` (extracted with visitor image input) | Sniffing, decoding under a pixel cap, re-encoding, stripping metadata | Who owns the image |
| `backend/src/modules/retrieval` | Carrying image refs on evidence items | Rendering, the model's pick |
| `backend/src/modules/chat` | The turn's image ledger and handles; the `present` head; building, persisting and streaming blocks; capability gating; validating a selection against the stored block | Ingestion formats; where bytes live; channel message formats |
| Image route | Serving a stored copy by capability id | Documents vs conversations beyond the lookup |
| WhatsApp connector | Block → carousel, image or reply-button message; `button_reply` → `item_select` | Documents, the ledger |
| Frontend `ChatMessageThread` | Renders `item_list` (carousel, grid, list), the `open` and `select` actions, and the selected state | Where images came from |
| `backend/src/app/composition` | Wires the codec, the storage, the route and the capability per channel | Product rules |

Dependency direction:
- Chat depends on retrieval's evidence type and on a narrow image-reference port.
- Documents depend on the shared fetch, codec and storage ports.
- Channel adapters depend on the block contract only.
- No domain module learns about `sharp` or GCS.

## User Scenarios & Testing

### User Story 1: A visitor sees picture cards in the answer (Priority: P1, slice 1)

A visitor asks for books on hiking. The answer is grounded in product pages that have covers. It comes with a short text and a carousel of the covers, each titled and linked to its page. A visitor asking "what does the guest house look like" gets a gallery of the photos from that page.

**Independent Test**: The scenario harness with fixture documents carrying captured images, run with the real mini model. Assert that every block item's image belongs to a document in the turn's evidence, that the layout follows the image roles, and that the text contains no image URL.

**Acceptance Scenarios**:

1. **Given** evidence from 5 documents with primary images, **When** the model presents 3, **Then** the reply carries one `carousel` block with those 3, in its order, persisted and replayed identically from history.
2. **Given** the model names a handle that is not in this turn's evidence, **When** the block is built, **Then** that handle is dropped and the turn succeeds.
3. **Given** a channel without the capability, **When** the same question is asked, **Then** no `present` head is offered and the reply is text as today.
4. **Given** an agent with images off, **When** the evidence has images, **Then** no `present` head is offered.
5. **Given** the document is deleted after the answer, **When** the history is reloaded, **Then** the card renders without its image.

### User Story 2: An operator's content brings its images (Priority: P1, slice 1)

**Acceptance Scenarios**:

1. **Given** a crawled page with `og:image` and three content images (one of them a 1×1 pixel), **When** it is processed, **Then** the page has one primary image and two inline images anchored to their chunks, and the pixel is skipped.
2. **Given** a WordPress product with a featured image, **When** it syncs, **Then** that image is the document's primary image.
3. **Given** an SVG, a private-address URL, an oversized file or a timeout, **When** it is captured, **Then** the document still processes, the image is skipped, and `document_image_capture_total{outcome}` records why.
4. **Given** a re-sync where one image was removed from the page, **When** it completes, **Then** that image's row and object are gone.
5. **Given** the document detail view, **When** the operator opens it, **Then** the captured images are listed.

### User Story 3: A visitor picks one (Priority: P1, slice 2)

The visitor taps **Select** on a card. Their message appears as the item's title, and the agent continues with that item as the subject.

**Acceptance Scenarios**:

1. **Given** a selection on a stored block in this conversation, **When** the turn arrives, **Then** the item is loaded from the stored block, never from client-sent fields, and the turn context carries it, with its document, as the subject.
2. **Given** a selection naming a block or item not in this conversation, **When** it arrives, **Then** the request is rejected with 400 and no turn runs.
3. **Given** a routine step that collects an item, **When** the visitor selects, **Then** the slot is filled from the selection (slot type `item` in `routine-definition`).
4. **Given** a reload, **When** the history renders, **Then** the selected card shows as selected.

### User Story 4: A WhatsApp visitor sees and picks cards (Priority: P1, slice 3)

**Acceptance Scenarios**:

1. **Given** 4 selectable items, **When** the turn replies, **Then** one carousel with 4 cards and a quick-reply button each is sent.
2. **Given** a gallery of 6 images without links, **When** the turn replies, **Then** at most 4 captioned image messages are sent.
3. **Given** a tap on a card, **When** the webhook arrives, **Then** it becomes `item_select` for that block and item.
4. **Given** Meta cannot fetch an image, **When** sending fails, **Then** the text is still delivered and `whatsapp_block_send_total{outcome}` records it.

### Edge Cases

- **Missing alt text.** Some catalogues send `alt: ""`. The title falls back to the document title. Captioning images with a model at ingestion is a later option, now that PR #1754 gives the LLM layer image input.
- **Decorative images in the main container.** These are banners and dividers. The size filter removes most of them, and the model sees no meaningful alt text and has no reason to pick them.
- **One image in many documents** (a logo inside the content). It is stored once per document. Within a turn, ledger entries are deduplicated by sha256.
- **The visitor taps Select twice, or on an old block.** The selection is idempotent per message, and an old block stays valid in its conversation.
- **A human owns the conversation.** A selection arrives in the Inbox as a visitor message, and the Inbox renders the block read-only.

## Delivery

**Slice 1: images from content, cards on the web.**
- The block contract and OpenAPI.
- Image capture in the crawler (metadata and linked images) and in WordPress (featured image).
- `document_images` with the image route.
- Evidence image refs and the `present` head on the grounded answer.
- Persist, stream and replay the block.
- The `ItemListBlock` (carousel and grid) with the `open` action.
- The capability on the embed and dashboard.
- Agent flag `answerImagesEnabled` (default off), with the Ray descriptor in the agent-settings tool.
- The images list in document detail.
- Docs and the SDK snapshot.

**Slice 2: selection on the web.**
- `item_select`, the selection fact, and the selected state.
- Slot type `item` in routines.
- The Inbox renders blocks.

**Slice 3: WhatsApp.**
- The adapter capability, the message mapping (D7), and taps.

**Slice 4: more sources.**
- Images embedded in DOCX and PDF, and markdown uploads.
- Live connector and tool results, with the provenance check and per-conversation storage (D4).

## Non-goals

- Facts: price, stock, quantities. Designed (`facts`) but not shipped.
- The `table` layout, the `item_detail`, `choices` and `form` kinds, and multi-select.
- Email, Slack and MCP renderers.
- Images uploaded by the visitor (`specs/visitor-image-input/`). That spec shares the codec.
- Showing images from non-grounded replies (routine steps, skill results) in slice 1. They join when their reply paths carry evidence.

## Key entities

- **Reply block**: a typed snapshot on an assistant message.
- **Document image**: a captured, re-encoded copy owned by a document, with role, anchor chunk, alt, caption and source URL.
- **Image ledger**: per turn, the images in the evidence, with handles. It is not persisted beyond the blocks built from it.

## Observability

- **Metrics:**
  - `document_image_capture_total{source, outcome}` (stored, reused, too_small, unsupported_type, too_large, blocked_address, timeout, decode_error)
  - `document_image_capture_duration_seconds`
  - `reply_blocks_emitted_total{layout, channel}`
  - `reply_block_items_dropped_total{reason}`
  - `whatsapp_block_send_total{message_type, outcome}`
- **Span:** around image capture, a child of the document job.
- **Logs** carry ids only. Image bytes, alt text and source URLs are never logged.
- **Selection** (slice 2): an analytics event with the item key, document id and channel.

## Open questions

1. **Sequencing with visitor image input.** That backend PR is being built and adds `sharp`, magic-byte sniffing and the eraser pattern. Slice 1's image capture should extract the shared codec after it merges, not build a second one. Everything else in slice 1 can start now.
2. **The default for `answerImagesEnabled`.** Off protects live agents from a visible change. On shows the feature to new agents.

---

# Amendment, Track 2: cards from tool results, selection, routine binding

**Created**: 2026-11-12 · **Status**: 2a.1 built (cards from a skill's result, this section as edited); 2a.2 and 2b drafted
**Replaces**: slice 2 (selection) and the "live tool results" half of slice 4. **Plan**: `plan-track2.md`.

## Why this exists

- **A skill's reply was plain text written from `outcome.answer`.** The renderer passed only `answer` as findings, and the composer generated text with no response format.
- **Data without text failed the turn.** A completed outcome without answer text settled as `empty_answer`.
- **MCP kept structured data and dropped images.** `structuredContent` became `outputs` (an array wrapped as `{structuredContent}`); only `text` blocks were read.
- **A routine step's reply never sees a tool's result.** The runner stages a skill's `outputs` and drops its `answer`; both step renderers read only the `retrieval.context` skill.
- **Slot values are scalars.** An object renders as `[object Object]` in step text and in ending notices.
- **The engine already has the right shape for a structured choice.** An approval decision is checked against the step's options, written to `captureKey`, and resumed with `decisionTurn: true`.

## Decisions

### D8. Cards from tool results need no operator mapping (built in 2a.1)

- **Records.** The host walks a skill's `outputs` structurally (`ToolRecordLedger`, `chat/services/replyBlocks/toolRecords.ts`). Every array whose items are all objects, at depth 4 or less, becomes records with handles `r1..rN` in document order; the walk does not go inside a record, so a listing's own `photos` never become records beside it. If there is none, the outputs themselves become `r1`. Each MCP `image` content block the skill returned becomes a record `{ "image": "tool-image:<n>" }`.
- **The model's view is compact and capped:**
  - at most 20 records;
  - per record: three levels of containers expanded, 12 keys, arrays cut to 3 items plus `"+N"`, strings cut to 120 characters;
  - an address with no query, fragment or credentials and at most 80 characters is shown whole, so a reply can link to it; a longer or signed one is shown as its origin and last path segment, and the section's heading says such an address is incomplete and is never written in the reply;
  - the whole section is at most **3,000 input tokens** by the pre-call estimate (`CHAT_BEHAVIOR.skillResult.maxRecordInputTokens`), trimmed from the end. The answer text gets the rest of the 4,800-token findings cap.
- **The `present` head** sits before `answer`:

  ```ts
  { records: string[];  // 0..10 handles, in display order
    fields: { title: string; subtitle: string | null; image: string | null; link: string | null }; // JSON Pointers relative to a record
    caption: string }    // 1..120 characters
  ```

  `selection` joins the head in 2a.2, where something acts on it; 2a.1 builds every block with `selection: "none"`.
- **The host resolves the values; the model writes none of them.** Pointers (RFC 6901, no `-`; a pointer written without its leading slash is read as if it had one) are resolved against the full, untruncated record.
  - The title must resolve to a string or a finite number, cut to 160 characters, or the item is dropped (`title_unresolved`).
  - The subtitle is cut to 400 characters.
  - `image` and `link` must be public `http(s)` URLs: a host the public internet reaches by its literal form, no credentials, at most 2,048 characters. `image` may also be the token of an MCP image this turn returned.
  - Any other value is left off that card (`field_unresolved`), never invented.
  - The item key is the record's JSON Pointer within `outputs` (`/` for the outputs themselves, `media/<n>` for an MCP image), hashed when it is over 128 characters.
  - The layout is `carousel` when any card has a picture and the client draws carousels, otherwise `list`. A tool image's size is unknown until it is copied, so the stored item frames it as 640×480 and the client fits the picture inside.
- **The offer rule.** `present` is offered only when the client declares `reply.blocks.item_list` and the outcome has at least one record. There is no agent flag: slice 1 offers evidence pictures on the capability alone, and skill-result cards follow it. A routine step's binding is the opt-in for routines (D10). Otherwise the prompt and the options are byte-identical to the reply without cards (golden: `backend/tests/fixtures/reply-blocks/skill-result-without-present.json`).
- **Records make data-only outcomes renderable.** An outcome with records and no text no longer fails (`hasRenderableResult`). Without the capability, the findings are the skill's text, exactly as before, and the records only when there is no text. With it, the findings are the records first and then the text, unless the text only repeats the structured content as JSON (parsed and compared deeply).
- **Cards are built only for a real answer.** A blank reply's fallback, a failed or suppressed skill, and an envelope whose `present` is missing or malformed build none.

### D9. Tool images are copied per conversation and deleted with it (built in 2a.1)

- **Rows.** `conversation_tool_images` (migration 259) holds one row per picture; the block stores only the row's id.
  - An address picture's row is written in the reply's own transaction, with the assistant message, by the `toolImages` module's `ToolImageRowWriter`. `source_url` is kept only until the picture is stored or fails, then cleared, because third-party links are often signed.
  - An MCP image's bytes are uploaded untouched while the tool call runs (`<id>-source`), and an unbound row records them (`source_object`); the reply that shows it binds it to its message. A conversation that is not stored (a replay, Test Chat) keeps no bytes; the drop is counted.
  - A Test Chat reply's address pictures are written with no conversation and no message (`ToolImagePreviewRecorder`), so Test Chat shows them, and the unbound sweep deletes them a day later.
- **Capture.** A `tool_images.capture` job is written in the same transaction and first runs five seconds after the commit. It fetches through `fetchPublicBytes` (10-second budget, 8 MB cap, `Accept: image/*`), sniffs, decodes and re-encodes with the shared codec (in a slot pool of its own) to WebP at 320 and 640 wide, stores the copies in the `tool-images` folder, and marks the row `stored`. A timeout, a network or server error and a busy decoder hand the row back and the job retries (4 attempts over about 15 minutes, then `retries_exhausted`); a private address, an expired link, a page, an SVG, a picture under 32 pixels or bytes that do not decode fail it for good.
- **On demand.** The image route is unchanged. Composition puts a tool-image lookup behind the documents' image lookup; it captures a waiting row on demand within a 6-second budget, one capture of a row at a time per process, and a request that finds another capture holding the row waits for it. A failed row is a plain 404.
- **Lifetime is the conversation's.** The row cascades with the conversation. `ToolImageEraser` deletes a conversation's rows in its erasure and hands their objects to the `tool_images.object_deletion` job in the same transaction, as `VisitorImageEraser` does. A row no message carries is swept after 24 hours. The data-subject export leaves the copies out: each is a third party's picture, and the card's title and link go out with the message.

### D10. Routines bind explicitly (PR 2b)

- **The binding.** A `chat` step may declare `present: { fromStep, selection }` in its typed step metadata. A `single` selection names the slot that receives the choice in `captureKey`. Today only approval steps take a `captureKey`.
- **What the model and the step decide.** The model picks the records and the fields. The step decides `selection`, so the head omits it.
- **When cards appear.** Cards show only on the turn the source step ran, while its result is staged. On a later turn at the same step, the reply is text.
- **Slot type `item`.** The value is `{ key, title, subtitle?, link?, imageId? }`, copied from the stored block item. It is filled only by a validated selection, never extracted from text, and renders as its title.

### D11. Selection is a structured fact (PR 2a.2)

- **The request.** `inputMetadata = { method: "item_select", selection: { messageId, blockId, itemKey } }`.
- **Validation.** The server loads the block from that assistant message's `metadata_json.blocks` in the same conversation. It requires `selection: "single"` and an existing key. Anything else is a `400`, and no turn runs.
- **What is stored.** The user message keeps the metadata. Its text is a structural tag holding the stored item, never the client's text. UIs show the title from the metadata.
- **Inside a routine.** When the block came from a routine step and the routine is still at that step, the engine writes the item into `captureKey` and resumes with `decisionTurn: true`. Otherwise the agent continues with the item as the subject.

### D12. Free tool choice stays out of scope

A model calling any skill mid-turn, without a directive or a routine, is an open question.

## Contract additions

- `StoredReplyBlock.origin?: { kind: "skill_result"; skillName }` (2a.1). Server-only: it is stored on the message and never presented. 2b adds `{ kind: "routine_step"; routineId; stepId; captureKey? }`.
- `SkillOutcome.media?: { kind: "image"; imageId: string }[]` in `@radioso/conversation-contract`. This is a reference, never bytes.
- `TestExecutionEvent` `side_completed.blocks?: ReplyBlock[]` (2a.1): Test Chat declares `reply.blocks` with every layout and gets a turn's cards on its completion.
- Later: `RoutineStep.present?` in the engine contract; `routineSlotTypes` gains `"item"`; embed copy keys `replyCardSelectLabel`, `replyCardSelectedLabel`.

## Boundaries

| Part | Knows | Must not know |
|---|---|---|
| `chat/services/replyBlocks/toolRecords.ts`, `recordPresentHead.ts`, `recordBlockBuilder.ts` (pure) | Walking outputs, handles, the compact view, pointer resolution, building items | Transports, storage, routines |
| `chat` skill-result renderer, `SkillResultReplyBlocks`, `AssistantReplyComposer` | Offering `present`, the `{present, answer}` envelope, building blocks with their origin | MCP, third-party formats, bytes |
| `chat` item selection (2a.2) | Validating against the stored block; the turn tag | Routine internals beyond the origin |
| `modules/toolImages` | Rows, intake, capture, on-demand lookup, eraser, sweep | Blocks, chat, MCP |
| `shared/infra/images`, `shared/infra/http` | Codec; bounded public fetch | Who owns an image |
| `externalSkills` | Turning an MCP image into a `ToolImageIntake` reference, bound to the calling conversation | Rows, cards |
| `routine-definition`, `routine-document` (2b) | The `present` binding, slot type `item`, validation codes | Records, blocks |
| `conversation-engine` (2b) | Applying an item selection; checking an `item` value | Where items come from |
| Frontend `ItemListBlock` | The Select action (2a.2) and the selected state | Where records came from |

## User scenarios

### US5: A visitor sees cards from a skill's result (P1, PR 2a.1)

The visitor asks "flats in Mitte under 2,000?". A directive-bound MCP skill returns invented `homes.example` listings. The reply is a short lead and a carousel of the matching listings, each with a photo, a name, an area and a link.

1. **Given** records with `photos[0].url` and `url` fields, **When** the model presents 4, **Then** each card's title, image and link come from the data, the block persists, and history replays it.
2. **Given** a handle that is not in the turn, or a title pointer that resolves to an object, **When** the block is built, **Then** that item is dropped and counted, and the turn succeeds.
3. **Given** an `image` pointer to a page URL, an SVG, a private address or an expired link, **When** it is captured, **Then** the card shows without a picture, and `tool_image_capture_total{outcome}` records why.
4. **Given** structured content only, with no text, and no capability, **When** the skill runs, **Then** the reply is text written from the records, not `empty_answer`.
5. **Given** the conversation is erased, **When** an image URL is requested, **Then** it returns `404`, and the objects are deleted by the job.
6. **Given** the operator tries the agent in Test Chat, **When** the skill returns listings, **Then** the completion carries the cards and their pictures load.

### US6: A visitor picks a card (P1, PR 2a.2)

1. **Given** a `single` block, **When** the visitor taps Select, **Then** their message shows the title, the turn carries the stored item, and a reload shows the card as selected.
2. **Given** a forged `itemKey`, a block from another conversation, or a `none` block, **When** the request arrives, **Then** it is rejected with `400` and nothing is stored.

### US7: The property flow (P1, PR 2b)

The steps are brief (`area`, `budget`, `rooms`) → tool step `search` with input bindings → chat step `choose` with `present: { fromStep: "search", selection: "single" }` and `captureKey: "property"` (type `item`) → hand-off on `slot_filled(property)`.

1. **Given** the brief is complete, **When** the turn runs `search` and lands on `choose`, **Then** that reply shows up to 10 cards with Select. The block's origin is `routine_step/choose`.
2. **Given** a tap, **When** the next turn arrives, **Then** `property` holds the item, the routine hands off, and the operator notice shows the title and the link.
3. **Given** the visitor types "the second one", **When** the turn arrives, **Then** `property` stays empty, and the step asks again.
4. **Given** `search` failed, **When** the routine reaches `choose`, **Then** the reply is text, and no block is built.
5. **Given** a tap on an older block after the routine moved on, **When** it arrives, **Then** no slot changes, and the agent treats it as an item-selection fact.
6. **Given** a binding to a step that is not a tool step, does not come before it, or has a non-`item` capture slot, **When** the routine is saved, **Then** the validator reports it.

## Observability

- **Metrics (2a.1):**
  - `reply_blocks_emitted_total{layout, channel, source}`, where `source` is `evidence` or `skill_result` (`routine_step` in 2b);
  - `reply_block_items_dropped_total{reason}`, with the record reasons `unknown_record`, `duplicate_record`, `over_limit`, `title_unresolved` and `field_unresolved`;
  - `tool_image_capture_total{trigger, outcome}` and `tool_image_capture_duration_seconds{trigger}`, where `trigger` is `job | on_demand`;
  - `tool_image_intake_dropped_total{reason}`.
- **Metrics (later):** `reply_item_selection_total{outcome}`, `routine_present_total{outcome}`.
- **Spans, traces, analytics:** a `tool_images.capture` span with its outcome; `chat.reply_blocks.record_count` on the turn; routine trace events `presented` and `item_selected` and analytics `reply_item_selected {channel, source}` later.
- **Logs** carry ids and error classes only. Never record values, titles, source URLs or bytes.

## Non-goals

- WhatsApp rendering (slice 3).
- Facts on cards; multi-select.
- Re-showing cards on a later turn of the step.
- Resolving typed references ("the second one") into a selection.
- Keeping an MCP tool's picture bytes for a Test Chat turn.

## Later

- **API sources:** turn an operator's OpenAPI document into tools through `conversation-tools`' OpenAPI adapter. Not designed here.
- **Provider plugins:** a `connector-api` capability that contributes tools. Not designed here.

## Open questions

1. Free tool choice (D12).
2. Typed references to presented items: let the slot extractor return a key from the latest block, validated by the host?
3. Should an `item` slot also keep a bounded copy of the record's scalars, so a later skill step can bind its upstream id?
4. Measure the on-demand capture's p95 under a burst of ten cards before a large rollout (`plan-track2.md` §6, risk 1).
