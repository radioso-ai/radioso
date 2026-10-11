# Email channel test fixtures (1403)

Raw `.eml` fixtures for the inbound MIME pipeline, thread resolution and header-based
classification (research.md A10, A11, A12; data-model.md; contracts/ports.md). All addresses
use `example.test`/`customer.test` (RFC 2606 reserved for documentation) and the fictional relay
domain `in.relay.test`; IPs use the RFC 5737 documentation ranges. Do not overwrite
`resend/README.md`, which documents the separate S0 provider-spike fixtures under `resend/`.

## `mime/` (T005)

- `first-contact.eml` — new thread, Google Workspace auto-forward to the relay token
  (`Delivered-To`/`X-Forwarded-For`/`X-Forwarded-To`, `for <...>` clause). Classification:
  `person`. Thread resolution: `new`.
- `pre-reply-follow-up.eml` — same sender replies to her own first message before any reply was
  sent (`In-Reply-To`/`References` = `first-contact.eml`'s Message-ID). Thread resolution:
  `existing`, `matchedBy: references` (forward match against the indexed inbound message).
- `header-threaded-reply.eml` — reply to the agent/operator's outbound message
  (`In-Reply-To: <out-0001@in.relay.test>`). Thread resolution: `existing`,
  `matchedBy: in_reply_to`.
- `participant-mismatch.eml` — different sender (`bob@example.test`) references the same
  outbound Message-ID as `header-threaded-reply.eml`. Thread resolution:
  `participant_mismatch`; disposition reason `participant_mismatch`.
- `token-only-reply.eml` — no `In-Reply-To`/`References`; reply arrives at the mailbox's
  plus-tagged address (preserved through the forward chain in `Delivered-To`/`X-Forwarded-For`).
  Thread resolution: `existing`, `matchedBy: thread_token` (plus-token fallback).
- `two-mailbox.eml` — `To:` lists two mailbox addresses (`support@customer.test`,
  `sales@customer.test`); Microsoft 365 auto-forward headers
  (`X-MS-Exchange-Organization-AutoForwarded: true`). Classification: `person`. Thread
  resolution: `new`.
- `out-of-order-parent.eml` / `out-of-order-child.eml` — a pair where the child's
  `In-Reply-To`/`References` name the parent's Message-ID; feed the child to the resolver before
  the parent to exercise the reverse match (B15 interleaving (ii)). Both resolve to the same
  conversation.
- `html-only.eml` — `multipart/alternative` with a single `text/html` part, no plain-text
  alternative. Classification: `person`. Thread resolution: `new`.
- `gmail-quoted-reply.eml` — Gmail quoting style: plain-text `On ... wrote:` line (ends in `:`)
  followed by a `>`-quoted block, and HTML `<div class="gmail_quote">`. Quoted-history
  stripping: `confident` (signals 1 and 2).
- `outlook-quoted-reply.eml` — Outlook plain-text quoting: `-----Original Message-----` plus a
  `From:`/`Sent:`/`To:`/`Subject:` block, no HTML part. No structural marker from A10's signal
  list matches this shape. Quoted-history stripping: `full_text` (open risk noted in research
  A10 — the full text is kept, not stripped).
- `apple-quoted-reply.eml` — Apple Mail quoting style: plain-text `> On ... wrote:` block and
  HTML `<blockquote type="cite">`. Quoted-history stripping: `confident` (signals 1 and 2).
- `non-english-quoted-reply.eml` — German client marker ("Am ... schrieb ...:", ends in `:`)
  followed by a `>`-quoted block, with no English vocabulary. Quoted-history stripping:
  `confident` via the language-agnostic structural signal 2 (no keyword list involved).
- `attachments.eml` — `multipart/mixed` with a plain-text body plus a base64 text attachment
  (`order-summary.txt`) and a base64 PDF attachment (`receipt.pdf`). Classification: `person`.
  Thread resolution: `new`.
- `encoded-word-subject.eml` — RFC 2047 `Subject:` encoded-word (`=?UTF-8?B?...?=`), decodes to
  "Rückfrage zu Bestellung: Preise für zwei Büros". Classification: `person`.
- `iso-8859-1-body.eml` — `Content-Type: text/plain; charset=iso-8859-1`,
  `Content-Transfer-Encoding: quoted-printable`; decodes to accented Spanish text. Classification:
  `person`.
- `direct-receiving.eml` — delivered straight to a customer-owned receiving domain
  (`care@receiving.customer.test`), no relay token, no forward chain. Mailbox routing:
  `direct` rule (B20). Classification: `person`. Thread resolution: `new`.

## `protocol/` (T006)

One header rule each, applied in the A12 classification order:

- `auto-submitted-auto-replied.eml` — `Auto-Submitted: auto-replied`. Classification:
  `automated_sender`.
- `auto-submitted-no.eml` — `Auto-Submitted: no`. Must NOT classify as automated.
  Classification: `person`.
- `precedence-bulk.eml` — `Precedence: bulk`. Classification: `automated_sender`.
- `precedence-list.eml` — `Precedence: list`. Classification: `automated_sender`.
- `precedence-junk.eml` — `Precedence: junk`. Classification: `automated_sender`.
- `x-auto-response-suppress.eml` — `X-Auto-Response-Suppress: All`. Classification:
  `automated_sender`.
- `list-id.eml` — `List-Id: Product Updates <updates.example.test>`. Classification:
  `automated_sender`.
- `dsn-radioso-id.eml` — `multipart/report; report-type=delivery-status` whose
  `message/rfc822` part carries `Message-ID: <out-0001@in.relay.test>`, a Radioso outbound id
  for the mailbox. Classification: `bounce`.
- `dsn-foreign-id.eml` — same DSN shape, but the `message/rfc822` part carries
  `Message-ID: <bulletin-55213@example.test>`, not a Radioso outbound id. Classification:
  `automated_sender` (per A12: a delivery-status report is `bounce` only when the referenced
  id is ours, otherwise `automated_sender`).
- `self-sender.eml` — `From: support@customer.test` equals the workspace mailbox's own address.
  Classification: `self_sender` (checked before every other rule).
