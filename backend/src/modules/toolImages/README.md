# Tool Images Module

Tool images owns the copies Radioso keeps of the pictures a reply's cards show
from a skill's result: a picture a record names by address, or one an MCP tool
returned as bytes. It writes their rows, keeps a tool's bytes while the call
runs, copies each picture into WebP renditions, serves the copy to the reply
image route, and deletes the copies with their conversation. Spec:
`specs/1763-reply-blocks/spec.md` (Track 2, D9).

## Boundaries

The module knows the picture lifecycle and nothing about blocks, chat turns or
MCP. Three ports face its callers, all in `contracts/index.ts`:

- `ToolImageRowWriter.record(transaction, …)`: the assistant-turn persistence in
  `modules/chat/infra/postgresAssistantTurnPersistence.ts` calls it in the
  reply's own transaction with the `ToolImageSource`s the reply's blocks carry.
  An address becomes a `pending` row; a picture already kept is bound to the
  message. It returns the `tool_images.capture` jobs, which the persistence
  writes in the same transaction.
- `ToolImagePreviewRecorder.recordPreview`: Test Chat's runner adapter
  (`modules/chat/services/trustedTestExecutionRunnerAdapter.ts`) records the
  address pictures of a test turn, whose conversation has no row, before it
  returns the answer. Those rows have no conversation and no message.
- `ToolImageIntake.accept`: the MCP executor
  (`modules/externalSkills/executor/mcpSkillExecutor.ts`) binds it to the
  calling conversation, and `toolService/mcpToolImages.ts` hands it the bytes of
  each MCP `image` content block. The bytes are stored untouched as
  `<id>-source`, an unbound row records them, and the skill's outcome carries
  only `media: [{ kind: "image", imageId }]`. A conversation that is not stored
  (a replay, Test Chat) gets no intake, and its pictures are dropped and counted.

Chat builds the cards and allocates each address picture's id
(`modules/chat/services/replyBlocks/recordBlockBuilder.ts`); this module never
reads a block. Storage is a port, `ToolImageObjectStore`, over document
storage's `tool-images` folder (`app/composition/toolImages.ts`). The codec and
the bounded fetch are shared infrastructure: `shared/infra/images/` and
`shared/infra/http/publicBytesFetch.ts`.

## Capture

`services/toolImageCapture.ts` copies one picture: it claims the row (a
`pending` one, or a `capturing` one whose claim is older than 30 seconds), reads
the source (the address through `fetchPublicBytes`, with a time budget, an 8 MB
cap and `Accept: image/*`, or the kept bytes), decodes it with the shared codec
in a slot pool of its own, writes WebP at 320 and 640 pixels wide, marks the row
`stored` and clears its source. A timeout, a network or server error and a busy
decoder hand the row back for a later attempt; anything else (a private
address, an expired link, a page, an SVG, a picture under 32 pixels, bytes that
do not decode) fails it for good with its reason.

Two triggers run it:

- the `tool_images.capture` job (`services/toolImageJobs.ts`), written with the
  reply and first run five seconds after it commits, retried over about fifteen
  minutes, after which the pictures still waiting fail as `retries_exhausted`;
- the reply image route, through `ToolImageLookup.findServable`
  (`services/toolImageLookup.ts`): a browser that asks for a picture before the
  job has copied it gets it copied on demand, within a 6-second budget. One
  capture of a picture runs at a time in a process; a request that finds
  another holding it waits for that one. A failed picture is a plain miss.

`app/composition/toolImages.ts` puts the lookup behind the documents' image
lookup, so the route serves both by image id without knowing which is which.

## Rows and deletion

`conversation_tool_images` (migration 258) keeps one row per picture.
`ToolImageEraser` (`infra/toolImagePrivacy.ts`) deletes a conversation's rows in
its erasure and hands their objects (the kept bytes and every rendition) to the
`tool_images.object_deletion` job in the same transaction;
`UnboundToolImageRetention` deletes the rows no message carries a day after
they were written. Both are registered in `app/composition/conversationErasure.ts`
and `conversationRetention.ts`. A copy is a third party's picture, so the
data-subject export leaves it out; the card's title and link go out with the
message that carried it.

## Observability

- `tool_image_capture_total{trigger, outcome}` and
  `tool_image_capture_duration_seconds{trigger}`, where `trigger` is `job` or
  `on_demand`;
- `tool_image_intake_dropped_total{reason}`, counted by the MCP executor;
- a `tool_images.capture` span per capture, with the outcome;
- logs carry ids and error classes only. An address, a title or a byte is never
  recorded: signed links are credentials.

## Tests

- `tests/unit/toolImages/tool-image-capture.test.ts`: capture outcomes, the
  on-demand lookup, single flight and the intake.
- `tests/unit/externalSkills/mcp-tool-images.test.ts`: MCP image content.
- `tests/integration/tool-result-cards.integration.test.ts`: the reply's rows
  and job, capture, history, erasure and the sweep on Postgres.
- `tests/contract/reply-image.contract.test.ts`: the route copies a waiting
  picture on demand and answers 404 once it failed.
