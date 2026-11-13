# Visitor Images Module

Visitor images owns the photos a visitor or an API caller attaches to a chat
message: validating and re-encoding the bytes, storing them under the
workspace, reading each one once with the agent's chat model, claiming a send's
photos and binding them to the message that carries them, serving them back,
and deleting them. Spec: `specs/visitor-image-input/spec.md`.

## Boundaries

The module is channel-neutral. Every channel hands it raw bytes and an owner
(`VisitorImageOwner`): the website embed and the public link their public chat
session, the REST API the credential (or the signed-in user), and a connector
its conversation. The owner id is never a credential; a send must come from the
same owner, agent and workspace as the upload.

A connector reaches the module through the host, never directly:
`modules/connectors/services/connectorImageTurns.ts` uploads the bytes a
connector hands `ConnectorChatPort.answer` (WhatsApp photos) with owner
`connector_conversation`, whose id is the conversation the sender is in, or an
id of its own for a first turn that has no conversation yet, and then sends the
turn through the chat door with the uploaded ids. Whatever the door does with a
web chat's photos it does with these.

It knows the photo lifecycle and nothing about chat turns or messages. The chat
door (`modules/chat/services/assistantChatService.ts`) depends on one narrow
port, `VisitorImageTurnInput` (`contracts/turnInput.ts`): `claim` the ids for an
owner and get the readings back, `bind` them to what holds the turn the caller
stored (`VisitorImageHolder`: a conversation and message id, or a Test Chat
test), and `release` them when the turn stored none. The door renders
the readings into the turn text with `renderVisitorImageTurn` and stores the
structured form as the user message's `inputMetadata.imageInput`, whose shape
the shared input-metadata vocabulary owns (`shared/domain/chatInputMetadata.ts`). This
module never reads `messages`.

It does not know which model reads a photo or how storage is reached:
`VisitorImageReader` and `VisitorImageObjectStore` (over document storage's
`locate`, `upload`, `read` and `delete`) are ports, and
`VisitorImageAvailability` (whether an agent takes photos now: by the switch
its published revision holds on every live channel, so an agent never published
takes none, or by the `revision` a Test Chat test names; the one rule is
`revisionTakesPhotos` in `contracts/revisionSwitch.ts`, where a revision without
a switch takes none) and
`ChatModelImageReading` (whether the agent's resolved chat model reads images,
which the agent settings read reports as `chatModelReadsImages` and the
availability check builds on) are implemented in composition. The one change in `packages/` is the connector contract: `connector-api`
gains `ConnectorChatPort.imageAllowance`, `ConnectorInboundImage`,
`ConnectorImageAllowance` and `ConnectorStoredImage`, for a connector that takes
photos (WhatsApp).

Test Chat sends photos through the same claim. A test keeps its transcript in
its own store, never in `conversations` and `messages`, so its photos are bound
to the test (`test_execution_id`, migration `258_visitor_images_test_chat.sql`)
rather than to a message. `modules/chat/services/testChatPhotoTurns.ts`
implements the test-execution module's `TestExecutionPhotoTurnsPort` over the
door's `claimVisitorImageTurn`: the same owner check (the credential or
signed-in user who uploaded through the test's own
`POST /api/v1/agents/:agentId/test-executions/:executionId/images`, whose reading
is charged as a test run),
the same turn text and `imageInput`, with the photo switch of the test's
revisions deciding instead of the published one. The test's store binds the claim to the test in the
transaction that stores the turn (`bindVisitorImageClaimIn`, wired in
`app/composition/testExecution.ts`), so a stored turn always names photos the
test holds; when no turn was stored the photos are let go. The photo switch is part of an agent
revision (`visitorImagesEnabled` on the snapshot): the agent's setting is the
draft's value and publishing freezes it, so a draft can take photos in Test Chat
before visitors get them. A test takes photos when every revision it runs does
(`TestExecutionService.photoSwitch`). `readForTestChat` serves a photo bound to the test,
then one its transcript names (from the comparison it continues or the
conversation it started from), then the caller's own upload before its turn is
stored, each read narrowly. Every view is audited, since every teammate can open
a test: a visitor's photo as `conversation.image_viewed`, any other as
`agent.test_execution.image_viewed`. Its route is
`app/http/routes/testChatImageRoutes.ts`.

## Public Surfaces

- `public.ts`: the turn port, `renderVisitorImageTurn`,
  `VISITOR_IMAGE_LIMITS`, `recordVisitorImageUpload`, and the service type the
  routes call.
- `composition.ts`: concrete classes for application wiring only — the Postgres
  store, the eraser, exporter and unbound sweep, the model reader, and the
  object deletion job handler.
- `contracts/turnInput.ts`: `VisitorImageOwner`, `VisitorImageTurnInput` and
  `VisitorImageClaim`.

## Read First

- `services/visitorImageService.ts`: upload (normalize, reserve an answer,
  insert the row, store the object, read, record the reading), claim, bind,
  release, and the two reads (owner, conversation with an audited view).
- `services/imageNormalizer.ts`: the visitor policy over the shared image
  codec in `shared/infra/images/`. It accepts JPEG, PNG and WebP only (by
  magic bytes), decodes with `sharp` under a pixel limit, auto-rotates, and
  re-encodes to a JPEG at most 1,600 px on the long side with no metadata,
  stepping quality down until it is at most 512 KB. Pixels that do not decode
  past a readable header are `unsupported_type`. `sharp` runs one libuv thread
  per image with its cache off. The module's `NormalizationSlots` pool, its
  share of the codec's process-wide two, lets two photos decode at once; a
  third waits up to five seconds, then is refused as `busy`
  (`503 visitor_image_busy`). `tests/unit/visitorImages/image-normalizer-byte-identity.test.ts`
  keeps the pre-extraction chain as an oracle for the output bytes.
- `services/modelVisitorImageReader.ts`: one structured call per photo on the
  agent's chat model through the inference pipeline (`visitor_image.read`), with
  a timeout and fail-open to `unread`. Prompt:
  `backend/prompts/chat/visitor-image-reading.md`.
- `infra/visitorImageRepository.ts`: `visitor_images` (migrations
  `256_visitor_images.sql` and `258_visitor_images_test_chat.sql`). A claim is
  one transaction, so of two concurrent sends of one photo exactly one claims
  it; binding sets the conversation and message ids the door names, or the
  test a Test Chat turn names, never both.
- `infra/visitorImagePrivacy.ts`: the conversation eraser, the 24-hour unbound
  sweep (a conversation retention rule) of photos no message and no test
  carries, and the data subject export section.
- `services/visitorImageObjectDeletion.ts`: the `visitor_images.object_deletion`
  background job. The eraser and the sweep write it in the same transaction as
  the rows they delete; the job deletes the objects after commit and refuses any
  path outside `workspaces/<ws>/visitor-images/`.

## Lifecycle

1. Upload: the route spends the rate budgets, then checks the agent takes
   photos (reading the agent and resolving its model), before multer buffers
   the body; the service re-encodes, reserves one answer
   against the plan (`UsageLimitPolicy.reserveAnswer`, `conversation_reply`, so
   an over-plan workspace gets the chat turn's `429 usage_limit_exceeded`),
   inserts the row (`pending`) naming where the object goes, then stores the
   object (deleting the row if that fails), reads it, and records `read`
   (keeping the answer) or `unread` (giving it back). An object never exists
   without a row; a row whose object never landed is swept, and deleting a
   missing object counts as deleted.
2. Send: the door claims the ids (all or none, one send per photo, and none
   once the agent no longer takes photos), renders
   `<attached_photo index="n">reading</attached_photo>` (only `<` and `>`
   escaped) or `<attached_photo index="n" status="unreadable"/>` after the typed
   text, and runs the turn. The tag names what it holds, so no prompt explains it.
3. Bind: the chat-session preparer tells the door the moment it stores the user
   message (`onUserMessageStored`), and the door binds the claim to that
   conversation and message id in the same request, before the rest of the turn
   runs. A turn that fails afterwards leaves the photos with the stored message;
   one that ends before storing it (refused, superseded while waiting, a stream
   abandoned early) releases the claim so the caller can send them again.
4. Delete: a conversation's erasure removes its photos and queues their objects;
   photos no message and no test carries are swept 24 hours after upload; a
   message deleted on its own leaves its photo unbound (`message_id` is
   `SET NULL`) for the sweep, and so does a Test Chat test deleted by Test
   Chat's retention (`test_execution_id` is `SET NULL`); a workspace's deletion
   cascades the rows and its storage purge removes the objects. A test that
   continues a comparison side shows that comparison's photos while the
   comparison is kept.

## Observability

The reading call runs inside the inference pipeline's `llm.provider` span and
records a usage event with operation `visitor_image.read`. Two bounded counters:
`visitor_image_uploads_total{outcome}` (accepted, rejected_type, rejected_size,
rejected_pixels, rate_limited, busy, disabled) and
`visitor_image_readings_total{outcome}` (read, unread). Logs carry ids, reasons
and error classes; never bytes, base64 or readings.

## Tests

- `cd backend && pnpm exec vitest run tests/unit/visitorImages tests/unit/shared/images tests/unit/chat/assistant-chat-visitor-images.test.ts tests/unit/chat/test-chat-photo-turns.test.ts tests/unit/test-execution-photo-turns.test.ts tests/unit/http/visitor-image-upload-rate-limiter.test.ts tests/contract/visitor-images.contract.test.ts tests/contract/test-chat-images.contract.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/visitor-images.integration.test.ts tests/integration/conversation-erasure-coverage.integration.test.ts tests/integration/data-subject-export-coverage.integration.test.ts --no-file-parallelism`
