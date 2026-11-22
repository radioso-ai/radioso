# Tool Images Module

Tool images owns the copies Radioso keeps of the pictures a reply's cards show
from a skill's result: the addresses the skill's records name. It writes their
rows, copies each picture into WebP renditions, serves the copy to the reply
image route, and deletes the copies with their conversation. Spec:
`specs/1763-reply-blocks/spec.md` (Track 2, D9).

## Boundaries

The module knows the picture lifecycle and nothing about blocks, chat turns or
MCP. Two ports face its callers, both in `contracts/index.ts`:

- `ToolImageRowWriter.record(transaction, …)`: the assistant-turn persistence in
  `modules/chat/infra/postgresAssistantTurnPersistence.ts` calls it in the
  reply's own transaction with the `ToolImageSource`s (`{imageId, url}`) the
  reply's blocks carry. Each becomes a `pending` row bound to the message. It
  returns the `tool_images.capture` jobs, which the persistence writes in the
  same transaction.
- `ToolImagePreviewRecorder.recordPreview`: Test Chat's runner adapter
  (`modules/chat/services/trustedTestExecutionRunnerAdapter.ts`) records the
  pictures of a test turn, whose conversation has no row, before it returns the
  answer. Those rows have no conversation and no message.

Chat builds the cards and allocates each picture's id
(`modules/chat/services/replyBlocks/recordBlockBuilder.ts`); this module never
reads a block. Storage is a port, `ToolImageObjectStore`, over document
storage's `tool-images` folder (`app/composition/toolImages.ts`). The codec and
the bounded fetch are shared infrastructure: `shared/infra/images/` and
`shared/infra/http/publicBytesFetch.ts`.

## Capture

`services/toolImageCapture.ts` copies one picture. It first takes one of the
process's capture turns (four by default, set through `wireToolImages`'s
`concurrentCaptures`), waiting within its deadline when all are taken, then
claims the row: a `pending` one, or a `capturing`
one whose claim is older than 30 seconds. `claimed_at` is the claim's
generation, and every write that finishes the capture (`markStored`,
`markFailed`, `release`) matches it, so a capture that outlived its claim
changes nothing. Each capture writes its WebP copies under names of its own,
`<imageId>-w<width>-<tag>`, so a capture that lost its claim can delete what it
wrote without touching the copies the row names.

It fetches the address through `fetchPublicBytes` (8 MB cap,
`Accept: image/*`), decodes it with the shared codec in a slot pool of its own,
writes WebP at 320 and 640 pixels wide, and marks the row `stored`, clearing its
address. One deadline covers all of it, the wait for a turn included: 20
seconds for the job, 6 for a browser waiting on the picture. Before it waits for
a turn, a capture reads the row without a lock: a picture already stored,
failed, missing or held by a fresh claim is answered at once, and only a
`pending` row or a stale claim waits. A capture with less than a second of its
deadline left does not claim the picture. A timeout, a network or server error
and a busy decoder hand the row back for a later attempt and hand off any copy
already written; anything else (a private address, an expired link, a page, an
SVG, a picture under 32 pixels, bytes that do not decode, a row with no address)
fails it for good with its reason.

Two triggers run it:

- the `tool_images.capture` job (`services/toolImageJobs.ts`), written with the
  reply and first run five seconds after it commits, retried over about fifteen
  minutes, after which the pictures still waiting fail as `retries_exhausted`.
  It stops when the runtime's abort signal fires and leaves the rest to the next
  run;
- the reply image route, through `ToolImageLookup.find`
  (`services/toolImageLookup.ts`): a browser that asks for a picture before the
  job has copied it gets it copied on demand. A carousel's browser asks for all
  its pictures at once, so a request that finds every capture turn taken waits
  for one, and one that finds another capture holding its picture waits for
  that one, both within the 6-second deadline. At most four requests per
  capture turn wait; past that a request is `busy` at once. A picture that
  failed is a miss at once; one not copied by the deadline is a miss, and the
  job copies it. A miss says whether a later request may find the picture, so
  WhatsApp's wait for a reply's pictures (`ReplyPictureReadiness`) stops at once
  on one that failed for good. The chat draws a card whose picture misses with
  an empty frame.

`app/composition/toolImages.ts` puts the lookup behind the documents' image
lookup, so the route serves both by image id without knowing which is which.

## Rows and deletion

`conversation_tool_images` (migration 260) keeps one row per picture.
`ToolImageEraser` (`infra/toolImagePrivacy.ts`) deletes a conversation's rows in
its erasure and hands their renditions to the `tool_images.object_deletion` job
in the same transaction; `UnboundToolImageRetention` deletes the rows no message
carries a day after they were written. Both are registered in
`app/composition/conversationErasure.ts` and `conversationRetention.ts`. The
data-subject export carries each card, with its picture's id, on the message
that showed it (`db/repositories/dataSubjectConversationRepository.ts`); the
copies themselves are a third party's pictures and stay out of it.

## Observability

- `tool_image_capture_total{trigger, outcome}` and
  `tool_image_capture_duration_seconds{trigger}`, where `trigger` is `job` or
  `on_demand`. `busy` counts a capture that found no capture turn in time, or
  too little of its deadline left, and never claimed the picture;
  `decoder_busy` one that claimed it and found the decoder full. A request for
  a picture that is stored, failed, missing or held by another capture is not a
  capture and is not counted here;
- `tool_image_miss_total{reason}`, one per reply image route request the lookup
  had no copy for: `busy` (no capture turn or decoder in time), `timeout` (the
  capture, or the one holding the picture, outlived the deadline),
  `unreachable`, `failed` or `not_found`. Each is logged as `tool_image_miss`
  with the image id, the reason and the capture's outcome: at `warn` for the
  first three, `info` for `failed`, and `debug` for `not_found`. Lookups from
  elsewhere, such as WhatsApp's wait for a reply's pictures, record nothing;
- `tool_image_capture_failed` at `info` once, when a capture fails a picture for
  good, with the image and workspace ids, the trigger and the reason;
- a `tool_images.capture` span per capture, with the outcome;
- logs carry ids and error classes only. An address, a title or a byte is never
  recorded: signed links are credentials.

## Tests

- `tests/unit/toolImages/tool-image-capture.test.ts`: capture outcomes, small
  WebP thumbnails, a takeover after the claim timeout, the deadline, waiting for
  a turn, answering settled pictures without a turn, the on-demand queue cap,
  the job's abort signal, and the on-demand lookup with a carousel of six, its
  miss reasons and when it records them.
- `tests/integration/tool-result-cards.integration.test.ts`: the reply's rows
  and job, capture, a takeover against the real `WHERE` clauses, the lock-free
  status read, a carousel's six pictures asked for at once, history, erasure and
  the sweep on Postgres.
- `tests/contract/reply-image.contract.test.ts`: the route copies a waiting
  picture on demand, serves all six pictures of a carousel asked for at once,
  and answers 404 once a picture failed.
