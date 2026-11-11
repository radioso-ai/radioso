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

It knows the photo lifecycle and nothing about chat turns or messages. The chat
door (`modules/chat/services/assistantChatService.ts`) depends on one narrow
port, `VisitorImageTurnInput` (`contracts/turnInput.ts`): `claim` the ids for an
owner and get the readings back, `bind` them to the conversation and message id
the turn stored, and `release` them when the turn stored none. The door renders
the readings into the turn text with `renderVisitorImageTurn` and stores the
structured form as the user message's `inputMetadata.imageInput`, whose shape
the message metadata owns (`db/repositories/messageInputMetadata.ts`). This
module never reads `messages`.

It does not know which model reads a photo or how storage is reached:
`VisitorImageReader` and `VisitorImageObjectStore` are ports, and
`VisitorImageAvailability` (whether an agent takes photos now) is implemented in
composition. Nothing in `packages/` changes for images.

## Public Surfaces

- `public.ts`: the turn port and metadata schema, `renderVisitorImageTurn`,
  `VISITOR_IMAGE_LIMITS`, `recordVisitorImageUpload`, and the service type the
  routes call.
- `composition.ts`: concrete classes for application wiring only — the Postgres
  store, the eraser, exporter and unbound sweep, the model reader, and the
  object deletion job handler.
- `contracts/turnInput.ts`: `VisitorImageOwner`, `VisitorImageTurnInput`,
  `VisitorImageClaim`, and the `imageInput` metadata schema.

## Read First

- `services/visitorImageService.ts`: upload (normalize, store, insert, read,
  record the reading), claim, bind, release, and the two reads (owner,
  conversation with an audited view).
- `services/imageNormalizer.ts`: magic-byte sniffing (JPEG, PNG, WebP only),
  `sharp` decode under a pixel limit, auto-rotate, re-encode to JPEG at most
  1,600 px on the long side with no metadata, quality stepped down to at most
  512 KB.
- `services/modelVisitorImageReader.ts`: one structured call per photo on the
  agent's chat model through the inference pipeline (`visitor_image.read`), with
  a timeout and fail-open to `unread`. Prompt:
  `backend/prompts/chat/visitor-image-reading.md`.
- `infra/visitorImageRepository.ts`: `visitor_images` (migration
  `256_visitor_images.sql`). A claim is one transaction, so of two concurrent
  sends of one photo exactly one claims it; binding sets the conversation and
  message ids the door names.
- `infra/visitorImagePrivacy.ts`: the conversation eraser, the 24-hour unbound
  sweep (a conversation retention rule), and the data subject export section.
- `services/visitorImageObjectDeletion.ts`: the `visitor_images.object_deletion`
  background job. The eraser and the sweep write it in the same transaction as
  the rows they delete; the job deletes the objects after commit and refuses any
  path outside `workspaces/<ws>/visitor-images/`.

## Lifecycle

1. Upload: the route checks the agent takes photos and spends the rate budgets
   before multer buffers the body; the service re-encodes, stores the object,
   inserts the row (`pending`), reads it, and records `read` or `unread`.
2. Send: the door claims the ids (all or none, one send per photo), renders
   `<visitor_image index="n">reading</visitor_image>` or
   `<visitor_image index="n" unread/>` after the typed text, and runs the turn.
3. Bind: the chat-session preparer tells the door the moment it stores the user
   message (`onUserMessageStored`), and the door binds the claim to that
   conversation and message id in the same request, before the rest of the turn
   runs. A turn that fails afterwards leaves the photos with the stored message;
   one that ends before storing it (refused, superseded while waiting, a stream
   abandoned early) releases the claim so the caller can send them again.
4. Delete: a conversation's erasure removes its photos and queues their objects;
   photos no message carries are swept 24 hours after upload; a message deleted
   on its own leaves its photo unbound (`message_id` is `SET NULL`) for the
   sweep; a workspace's deletion cascades the rows and its storage purge removes
   the objects.

## Observability

The reading call runs inside the inference pipeline's `llm.provider` span and
records a usage event with operation `visitor_image.read`. Two bounded counters:
`visitor_image_uploads_total{outcome}` (accepted, rejected_type, rejected_size,
rejected_pixels, rate_limited, disabled) and
`visitor_image_readings_total{outcome}` (read, unread). Logs carry ids, reasons
and error classes; never bytes, base64 or readings.

## Tests

- `cd backend && pnpm exec vitest run tests/unit/visitorImages tests/unit/chat/assistant-chat-visitor-images.test.ts tests/unit/http/visitor-image-upload-rate-limiter.test.ts tests/contract/visitor-images.contract.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/visitor-images.integration.test.ts tests/integration/conversation-erasure-coverage.integration.test.ts tests/integration/data-subject-export-coverage.integration.test.ts --no-file-parallelism`
