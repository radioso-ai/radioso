# Visitor image input

Status: Draft — decisions settled 11-11.

## Problem

A visitor can only describe what they want in words. Some requests are easier to show than to write: a reference
photo of the kind of property someone is looking for, a product they want to replace, a document they have in hand.
The reference case is property matching: a client sends a photo of the kind of place they need ("something like
this"), and the agent has to turn it into terms it can search with, then collect the rest of the brief and run the
match.

Today the whole conversation path is text-only: the public chat schema, `ConversationMessage.content`,
`TextGenerationRequest`, and all three provider adapters. No chat surface has an attachment control.

## Outcome

On an agent whose operator turned image input on, a visitor in the website embed, the public chat link or WhatsApp, or a caller of the REST API or SDK, can attach
up to three photos to a message. The agent reads each photo once, and the reading becomes part of what the visitor
said. From there, the existing machinery does the structuring and the querying:

- routing and the turn plan see it;
- routine slot extraction fills operator-authored slots from it (for example property type, style, era and features);
- retrieval rewrites it into a search;
- skills receive the slot values as arguments (for example an MCP tool over the property database).

The visitor sees their photo in the thread, including after a reload. The operator sees the photo and the agent's
reading of it in the conversation history.

## Design

### Where the reading happens: the chat door, at upload time

The photo is read when it is uploaded, not when the message is sent, so the vision call runs while the visitor is
still typing. At send, the door (`AssistantChatService`) renders the message text and the readings into one turn
text. This follows the routine-invocation precedent (`renderRoutineInvocation`): derived text goes in `content`, and
the structured form goes in `inputMetadata`. It was chosen over the alternatives:

- **The engine, or a routine slot extractor.** These were rejected because `packages/conversation-*` are generic and
  text-only, and every extractor (selector, activator, planner, rewrite) would otherwise need its own image path.
  Routine steps could also make up to three calls per turn.
- **The chat-session preparer.** Rejected because the preparer, `chatService.ts` and `chatTurnAssembly.ts` are
  baselined against growth.
- **A skill.** Rejected because a skill runs too late: routing and slot extraction have already happened.

The persisted user message carries:

- `content`: the visitor's text followed by one `<attached_photo index="n">reading</attached_photo>` block per photo,
  or `<attached_photo index="n" status="unreadable"/>` when the reading failed. The tag names what it holds, so the
  answering model reads it without a prompt explaining it; only `<` and `>` are escaped in a reading. The rendering is
  structural and language-neutral.
  Every transcript reader picks it up unchanged: history, summaries, facets, notices, eval capture and export. The
  photo's text form is in the transcript the same way a voice transcript is.
- `inputMetadata.imageInput`: `{ typedText, images: [{ id, reading | null }] }`. The UIs render this as the visitor's
  text plus thumbnails, so the reading never appears inside the visitor's own bubble.

Anything written inside a photo has the same trust level as typed text, because the visitor authored both. The
reading prompt transcribes visible text as quoted content and never as instructions.

### Reading a photo

- **Model.** The agent's chat model, resolved the usual way: agent override, then workspace preference, then managed
  plan or BYOK. It needs `imageInputCapability` (#1754), modelled on `cacheCapability`. Every closed-catalog model reads
  images; `openai-compatible` is treated as unable to.
- **Call.** It goes through `ModelInferencePipeline` with a strict JSON result `{ description }`, the
  `askStructured` / email-triage shape: a timeout, fail-open behaviour, `validateResult`, and a usage event.
- **Prompt.** `backend/prompts/chat/visitor-image-reading.md`. It asks for a factual description for search and
  matching, covering kind or category, style, era, setting, materials, colours, notable features, condition, and
  quoted visible text. It must not identify people, must say when something is uncertain, and writes in the session's
  expected locale, falling back to the agent's default locale.
- **Failure.** A failed reading stores the photo as unread, and the turn proceeds. The LLM writes whatever the
  visitor is told, with no hard-coded copy.

### Upload, storage and lifetime

New module `backend/src/modules/visitorImages/` (README brief included). It is channel-neutral. Every channel hands
it raw bytes plus an owner, and gets back an image id.

- **Owner.** The principal that may later use the image in a turn:
  - website embed or public link: the public chat session;
  - API: the authenticated credential or account;
  - WhatsApp: the connector conversation.
  The row stores this as an owner kind plus id, and the door checks it at send.
- **Size.**
  - The browser downsizes before uploading (website embed and public link), to a long side of at most 1600 px as JPEG
    at about 0.85 quality. A phone photo goes up as roughly 200–400 KB instead of several MB.
  - The server is the authority for every channel, including API and WhatsApp, which have no browser step:
    - the type is sniffed from magic bytes (JPEG, PNG, WebP only) and the declared type is ignored;
    - the image is decoded with `sharp` under a pixel limit and auto-rotated;
    - it is re-encoded to JPEG with a long side of at most 1600 px, dropping EXIF and GPS;
    - quality steps down until the stored file is at most 512 KB.
  - The raw upload cap is 10 MiB. A message carries at most 3 images.
- **Upload routes.** Each takes multipart with one file and returns the image id plus its reading status.
  - Public: `POST /api/v1/public/chat/:token/images`. The middleware chain is the public session,
    `public_chat.turn.create`, a three-budget rate limiter (session plus source, source, workspace) modelled on the
    voice-session start, and then the per-agent flag, so the budget is spent before the agent is read.
  - API: an upload route beside the authenticated chat route the REST API and SDK use, under the same auth and
    permission. Rate-limited per credential and per workspace.
  - multer has `files`, `fields` and `parts` limits. Rate limiting runs before the body is buffered.
- **WhatsApp.** An inbound image message downloads the media through the Graph API with the connector's token, goes
  through the same validation and storage, and is read. Its caption becomes the typed text.
  - The connector already answers messages from one number that arrive within three seconds as one
    turn, so an album's photos (at most three, in the order sent) are one turn with their captions
    joined. Photos beyond the third are unsupported messages. No new coalescing exists.
  - The turn goes through the chat door with the ids the upload returned and owner
    `connector_conversation`: the conversation's id, or an id of its own for a first turn.
  - A retry reuses what an earlier attempt stored. The host hands the connector a receipt per stored photo
    (`ConnectorStoredImage`), before the turn runs; the connector keeps it in the inbound message's log row (the
    jsonb payload, under a `radioso` key, so no migration) and sends it back instead of the bytes. A receipt names
    the photo and the owner it was stored for. A receipt that cannot be claimed (the message was stored and
    already carries the photo, or the photo was swept) is refused as stale and the photo is sent again.
  - A photo whose download fails for good counts as an unavailable photo: captions and text are answered and an
    uncaptioned photo is an unsupported message. Transient failures retry first.
- **Bytes.** Stored through `DocumentStoragePort` under `workspaces/<ws>/visitor-images/<id>`, so a workspace purge
  covers them.
- **Row.** Table `visitor_images` holds:
  - workspace, agent, owner kind and id;
  - conversation and message, both `ON DELETE CASCADE` and nullable until bound;
  - the storage descriptor, byte size, dimensions, sha256;
  - the reading and its status, and the times.
- **Binding.** At send, each id must belong to the same workspace, agent and owner, and must be unused; the door
  claims them all or none. The preparer tells the door the moment it stores the user message
  (`onUserMessageStored`), and the door binds the claim to that conversation and message id before the rest of the
  turn runs. A turn that ends before storing the message releases the claim. An image is used once.
- **Erasure.** A conversation eraser writes the object descriptors to a durable deletion backlog in the same
  transaction, and a job deletes the objects after commit (the voice-recording pattern). Retention follows the
  conversation. Photos that are never sent are deleted 24 h after upload. Data-subject export lists each photo's
  metadata and reading.
- **Serving.**
  - The visitor uses `GET /api/v1/public/chat/:token/images/:id`. It is restricted to the same public session, with
    `private, no-store` and a sandbox CSP.
  - The operator uses `GET /api/v1/conversations/:conversationId/images/:id`. It requires `workspace.history.read`
    and is audited per view, like recording playback.

### Operator control

- **Flag.** `visitorImagesEnabled` on the agent, default off. It follows the `contactRequestsEnabled` path through
  the agent schema, bundle and OpenAPI.
- **Effect.** The public session response tells the client whether this agent accepts photos. The flag can only take
  effect when the agent's chat model reads images, and the setting explains this when it cannot.
- **Ray.** Ray can read and set the flag through the agent-settings tool. This is the copilot descriptor required by
  the architecture rule.

### Observability

- The model call is covered by the existing `llm.provider.complete` span and the usage ledger, with operation
  `visitor_image.read`.
- One bounded counter records the upload outcome (accepted, rejected type, rejected size, rejected pixels, rate
  limited, disabled), and one records the reading outcome (read, unread).
- Logs carry ids only. Bytes and readings are never logged.

## Module knowledge and ports

- **`shared/infra/llm`** knows how to send image parts to OpenAI, Claude and Gemini, and which models can read them.
  It knows nothing about visitors.
- **`modules/visitorImages`** knows the photo lifecycle: validate, store, read through a `VisitorImageReader` port,
  bind, serve, and erase. It does not know chat turns.
- **The chat door** depends on one narrow port, `VisitorImageTurnInput`: claim ids for this owner and get back
  readings, bind them to the stored message, or release them. It does not know storage. The `imageInput` metadata
  shape belongs to the message metadata, so `visitorImages` never reads `messages`.
- **Composition** implements the reader on the agent's resolved chat model and wires the eraser, the export, the
  sweep and the routes.

Dependency direction: chat depends on the visitorImages port, visitorImages depends on the shared llm and storage
ports, and composition assembles. The one change in `packages/` is the connector contract: `connector-api` gains
`ConnectorChatPort.imageAllowance`, `ConnectorInboundImage`, `ConnectorImageAllowance` and `ConnectorStoredImage`, for
a connector that takes photos (WhatsApp).

## Delivery

1. **`feat(llm): pass images to the chat models that can read them`** (#1754). Image parts on `TextGenerationRequest`,
   the three adapters, the `stripOperation` whitelist, the input-budget estimate, and `imageInputCapability`.
2. **`feat(chat): let visitors and API callers attach images the agent reads`.**
   - The migration and the module.
   - The public and API upload routes, plus the visitor and operator image routes.
   - `imageIds` on the public chat and the authenticated chat requests.
   - Door rendering, erasure, the unbound sweep and export.
   - The agent flag and Ray.
   - OpenAPI and SDK regeneration, with an SDK upload helper.
   - Docs.
3. **`feat(chat): attach images from the chat composer`.**
   - The attach control in the website embed and the public chat link: picker, paste and drop, the browser downsizer,
     preview chips, and remove.
   - Thumbnails in the visitor thread and in the operator conversation view, including the reading.
   - The agent setting toggle.
   - Embed copy packs for every locale.
   - A Playwright journey.
   - Docs.
4. **`feat(whatsapp): read the images visitors send`.** Media download, the caption as typed text, and the same module
   and door. This includes how several photos sent in a row become turns.
5. **`feat(chat): attach photos in Test Chat`.** The Test Chat composer takes photos through the assistant upload route,
   and a test message's `imageIds` go through the door's claim and rendering. A test keeps its transcript apart from
   `conversations`, so its photos bind to the test (`test_execution_id`, migration 258, `ON DELETE SET NULL` so the
   unbound sweep removes them with the test). The photo switch is part of an agent revision (missing = off): the draft
   holds the agent's setting, publishing freezes it, live channels follow the published revision and Test Chat the
   revisions under test. Ray's `send_test_chat_message` stays text-only; Talk sends no photos.

## Matching recipe (docs, no new code)

A "brief" routine with text slots that the photo fills (for example property type, style, era and notable
features), plus the slots only the visitor can answer (region, dates, budget, contact). It then runs one of two
lookups:

- **A `retrieve` step** over a corpus with one document per property. This gives grounded answers with citations.
- **An `external_mcp` skill** whose `exposedParams` bind to the slots, for a live property database.

Known limits on the second path: routine skill results present object outputs badly, and directive-bound MCP skills
need a text answer from the tool.

## Out of scope (follow-ups)

- Images on Slack, email, voice, MCP converse and A2A.
- Image cards in agent replies, for example showing matched properties.
- Reading images inside the document corpus.
- Typed attribute extraction against an operator field catalog and matching by metadata filter (decision 2).
- Camera capture: the Permissions-Policy is `camera=()`, while the file picker still offers the camera on mobile.

## Decisions

1. **Keep images with the conversation**, bounded in size: a browser downsizer plus a server re-encode to at most
   512 KB per image. The operator sees the reference photo, and it is erased with the conversation. (11-11)
2. **Structure via routine slots.** Operator-authored slots are filled from the reading, and the search runs by
   meaning. Typed attributes against a field catalog stay a follow-up, to add only if matching needs to be stricter.
   (11-11)
3. **Channels:** website embed, public chat link, WhatsApp and the REST API with the SDK. (11-11)
