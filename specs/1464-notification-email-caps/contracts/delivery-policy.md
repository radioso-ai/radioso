# Internal Contract: Notification Delivery Admission

## Limit Resolver

Input: account/workspace identity.

Output: a finite positive integer representing recipient email attempts permitted per UTC day. OSS returns 100. EE returns the assigned catalog plan's allowance and falls back to the OSS default for an unrecognized or absent catalog profile.

## Admission Request

Input:

- unique action request identity;
- workspace identity;
- optional conversation identity;
- resolved email-recipient count.

Output:

- whether the overall dispatch is allowed;
- whether email is allowed;
- one bounded reason: `none`, `workspace_daily_email_cap`, or `conversation_dispatch_cap`;
- whether this call first recorded the decision, so audit emission is idempotent.

## HTTP And Operator Authorization

Existing request/response schemas remain unchanged. When an agent `contactRequestDelivery.recipientEmails` or notify-skill `delivery.recipientEmails` value is present in a mutation, the caller also needs `workspace.notification_recipients.manage`. Owners and administrators hold it; members do not.

## Webhook Signature

Contact and operator-notice webhook requests carry:

- `Idempotency-Key`;
- `X-Radioso-Timestamp` as Unix seconds;
- `X-Radioso-Signature` as `sha256=<hex HMAC-SHA256(timestamp + "." + rawBody)>`.

The exact configured webhook URL is the shared secret for this existing URL-as-secret configuration model.
