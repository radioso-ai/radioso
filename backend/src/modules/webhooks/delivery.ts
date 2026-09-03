// The signed outbound-webhook transport is generic: it knows how to sign and POST a
// body, not what a webhook destination is. It lives in shared/ so callers outside this
// module — including observability sinks — can reach it without depending on a module.
export {
  FetchWebhookHttpClient,
  createSignedWebhookHeaders,
  verifyWebhookSignature,
  type WebhookHttpClient,
  type WebhookUrlGuard,
} from "../../shared/infra/http/signedWebhook.js";
