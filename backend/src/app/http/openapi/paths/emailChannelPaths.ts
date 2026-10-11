import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";
import { registerEmailChannelSchemas } from "../schemas/emailChannelSchemas.js";

const TAGS = ["Email Channel"];
const SETTINGS = "/api/v1/workspaces/{workspaceId}/email-channel";

const WorkspaceParams = z.object({ workspaceId: z.string().uuid() });
const MailboxParams = WorkspaceParams.extend({ mailboxId: z.string().uuid() });
const DomainParams = WorkspaceParams.extend({ domainId: z.string().uuid() });
const EventParams = WorkspaceParams.extend({ deliveryId: z.string().uuid() });
const ConversationParams = z.object({ conversationId: z.string().uuid() });

/**
 * The email channel's settings (`workspace.settings.read` / `manage`) and the inbox's email facts
 * for one conversation (`workspace.conversation.takeover`). The provider webhook is mounted by the
 * connector host and is not part of this surface.
 */
export const registerEmailChannelPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const email = registerEmailChannelSchemas(registry);
  const sec = [{ [security.bearerAuthScheme.name]: [] }];
  const json = (schema: z.ZodTypeAny) => ({ "application/json": { schema } });
  const errorResponse = (description: string) => ({ description, content: json(schemas.ErrorResponseSchema) });
  const unauthenticated = errorResponse("Authentication required");
  const settingsReadRequired = errorResponse("Workspace settings permission required");
  const settingsManageRequired = errorResponse("Workspace settings manage permission required");
  const notConfigured = errorResponse("`email_channel_not_configured`: this deployment has no email provider");
  const body = (schema: z.ZodTypeAny) => ({ required: true, content: json(schema) });

  registry.registerPath({
    method: "get",
    path: SETTINGS,
    tags: TAGS,
    summary: "Read the email channel's settings",
    description: "The deployment's engagement modes and inbound domain, with the workspace's sending domains and mailboxes. A deployment with no email provider answers `configured: false`.",
    operationId: "getEmailChannel",
    security: sec,
    request: { params: WorkspaceParams },
    responses: {
      200: { description: "Email channel settings", content: json(email.EmailChannelOverviewSchema) },
      401: unauthenticated,
      403: settingsReadRequired,
      404: errorResponse("Workspace not found"),
    },
  });

  registry.registerPath({
    method: "post",
    path: `${SETTINGS}/mailboxes`,
    tags: TAGS,
    summary: "Add a mailbox",
    description: "Registers the address's domain as a sending domain when it is new to the workspace and issues the mailbox's relay address.",
    operationId: "createEmailMailbox",
    security: sec,
    request: { params: WorkspaceParams, body: body(email.CreateEmailMailboxRequestSchema) },
    responses: {
      201: { description: "Mailbox created", content: json(email.EmailMailboxSchema) },
      400: errorResponse("`invalid_address`, `auto_opt_in_required`, or a setting outside its bounds"),
      401: unauthenticated,
      403: settingsManageRequired,
      409: errorResponse("`mailbox_exists`, `domain_claimed_elsewhere` (names no other workspace), `domain_needs_reconciliation` (reconcile the domain first), `domain_removal_pending` or `engagement_mode_unavailable`"),
      502: errorResponse("`provider_unavailable`: the email provider could not register the address's domain"),
      503: notConfigured,
    },
  });

  registry.registerPath({
    method: "get",
    path: `${SETTINGS}/mailboxes/{mailboxId}`,
    tags: TAGS,
    summary: "Read a mailbox",
    operationId: "getEmailMailbox",
    security: sec,
    request: { params: MailboxParams },
    responses: {
      200: { description: "Mailbox", content: json(email.EmailMailboxSchema) },
      401: unauthenticated,
      403: settingsReadRequired,
      404: errorResponse("Mailbox not found"),
      503: notConfigured,
    },
  });

  registry.registerPath({
    method: "patch",
    path: `${SETTINGS}/mailboxes/{mailboxId}`,
    tags: TAGS,
    summary: "Update a mailbox's settings and engagement policy",
    description: "A change of engagement mode, enabled flag or agent writes the next `policyVersion`. With `expectedPolicyVersion`, the change applies only to that version. Switching to `auto` needs `autoOptIn: true`.",
    operationId: "updateEmailMailbox",
    security: sec,
    request: { params: MailboxParams, body: body(email.UpdateEmailMailboxRequestSchema) },
    responses: {
      200: { description: "Mailbox updated", content: json(email.EmailMailboxSchema) },
      400: errorResponse("`auto_opt_in_required`, or a setting outside its bounds"),
      401: unauthenticated,
      403: settingsManageRequired,
      404: errorResponse("Mailbox not found"),
      409: errorResponse("`stale_policy_version` or `engagement_mode_unavailable`"),
      503: notConfigured,
    },
  });

  registry.registerPath({
    method: "delete",
    path: `${SETTINGS}/mailboxes/{mailboxId}`,
    tags: TAGS,
    summary: "Remove a mailbox",
    operationId: "removeEmailMailbox",
    security: sec,
    request: { params: MailboxParams },
    responses: {
      204: { description: "Mailbox removed" },
      401: unauthenticated,
      403: settingsManageRequired,
      404: errorResponse("Mailbox not found"),
      503: notConfigured,
    },
  });

  registry.registerPath({
    method: "post",
    path: `${SETTINGS}/mailboxes/{mailboxId}/relay-token/rotate`,
    tags: TAGS,
    summary: "Issue a new relay address for a mailbox",
    description: "The previous relay address keeps working for a seven-day grace period.",
    operationId: "rotateEmailMailboxRelayToken",
    security: sec,
    request: { params: MailboxParams },
    responses: {
      200: { description: "Mailbox with its new relay address", content: json(email.EmailMailboxSchema) },
      401: unauthenticated,
      403: settingsManageRequired,
      404: errorResponse("Mailbox not found"),
      503: notConfigured,
    },
  });

  registry.registerPath({
    method: "post",
    path: `${SETTINGS}/mailboxes/{mailboxId}/setup-check`,
    tags: TAGS,
    summary: "Start a forwarding setup check",
    description: "`base` passes on the next message the mailbox receives; `plus_address` passes when a message written to the check's plus address arrives with its tag intact.",
    operationId: "startEmailMailboxSetupCheck",
    security: sec,
    request: { params: MailboxParams, body: body(email.StartEmailMailboxSetupCheckRequestSchema) },
    responses: {
      200: { description: "Setup check started", content: json(email.EmailMailboxSetupCheckSchema) },
      400: errorResponse("Request validation failed"),
      401: unauthenticated,
      403: settingsManageRequired,
      404: errorResponse("Mailbox not found"),
      503: notConfigured,
    },
  });

  registry.registerPath({
    method: "get",
    path: `${SETTINGS}/mailboxes/{mailboxId}/events`,
    tags: TAGS,
    summary: "List a mailbox's event log",
    description: "Every accepted delivery to the mailbox, newest first, with its disposition, sender, subject and time.",
    operationId: "listEmailMailboxEvents",
    security: sec,
    request: { params: MailboxParams, query: email.ListEmailMailboxEventsQuerySchema },
    responses: {
      200: { description: "A page of the event log", content: json(email.EmailEventPageSchema) },
      400: errorResponse("`invalid_cursor`, or an invalid query"),
      401: unauthenticated,
      403: settingsReadRequired,
      404: errorResponse("Mailbox not found"),
      503: notConfigured,
    },
  });

  registry.registerPath({
    method: "get",
    path: `${SETTINGS}/events`,
    tags: TAGS,
    summary: "List the workspace's email event log",
    description: "Every delivery attributed to the workspace, newest first: its mailboxes' events, a removed mailbox's retained events, and mail a verified receiving domain accepted for an address no mailbox has (`mailboxId: null`, reason `no_mailbox`). `mailboxId` narrows the log to one mailbox, removed or not.",
    operationId: "listEmailChannelEvents",
    security: sec,
    request: { params: WorkspaceParams, query: email.ListEmailChannelEventsQuerySchema },
    responses: {
      200: { description: "A page of the event log", content: json(email.EmailEventPageSchema) },
      400: errorResponse("`invalid_cursor`, or an invalid query"),
      401: unauthenticated,
      403: settingsReadRequired,
      503: notConfigured,
    },
  });

  registry.registerPath({
    method: "post",
    path: `${SETTINGS}/events/{deliveryId}/retry`,
    tags: TAGS,
    summary: "Retry a failed inbound event",
    description: "Returns the failed delivery to the inbound pipeline, resuming at the step where it stopped.",
    operationId: "retryEmailInboundEvent",
    security: sec,
    request: { params: EventParams },
    responses: {
      202: { description: "Retry accepted", content: json(email.EmailEventSchema) },
      401: unauthenticated,
      403: settingsManageRequired,
      404: errorResponse("Event not found"),
      409: errorResponse("`event_not_failed`"),
      503: notConfigured,
    },
  });

  registry.registerPath({
    method: "get",
    path: `${SETTINGS}/events/{deliveryId}/raw`,
    tags: TAGS,
    summary: "Read an inbound event's raw message",
    description: "Display-safe headers, the plain text and server-sanitized HTML. Requires `workspace.conversation.takeover` as well as settings read permission, and every view is audited.",
    operationId: "getEmailInboundRawMessage",
    security: sec,
    request: { params: EventParams },
    responses: {
      200: { description: "Sanitized raw message", content: json(email.EmailRawMessageViewSchema) },
      401: unauthenticated,
      403: errorResponse("Workspace settings read and conversation takeover permissions required"),
      404: errorResponse("Event not found"),
      410: errorResponse("`raw_purged`: the raw message is no longer stored"),
      503: notConfigured,
    },
  });

  registry.registerPath({
    method: "post",
    path: `${SETTINGS}/domains`,
    tags: TAGS,
    summary: "Add a sending domain",
    description: "Claims the domain for the workspace and registers it with the email provider. When the provider already holds the domain, it is added with `registration.status: needs_reconciliation` and adopted only by `reconcileEmailDomain`.",
    operationId: "addEmailSendingDomain",
    security: sec,
    request: { params: WorkspaceParams, body: body(email.AddEmailSendingDomainRequestSchema) },
    responses: {
      201: { description: "Sending domain added, with the DNS records to publish", content: json(email.EmailDomainSchema) },
      400: errorResponse("`invalid_domain`"),
      401: unauthenticated,
      403: settingsManageRequired,
      409: errorResponse("`domain_claimed_elsewhere` (names no other workspace) or `domain_removal_pending`: the domain's removal is still being cleaned up at the provider"),
      502: errorResponse("`provider_unavailable`"),
      503: notConfigured,
    },
  });

  registry.registerPath({
    method: "post",
    path: `${SETTINGS}/domains/{domainId}/verify`,
    tags: TAGS,
    summary: "Check a domain's DNS records now",
    operationId: "verifyEmailDomain",
    security: sec,
    request: { params: DomainParams },
    responses: {
      200: { description: "Domain with refreshed readiness", content: json(email.EmailDomainSchema) },
      401: unauthenticated,
      403: settingsManageRequired,
      404: errorResponse("Domain not found"),
      409: errorResponse("`domain_needs_reconciliation`: reconcile the domain first"),
      502: errorResponse("`provider_unavailable`"),
      503: notConfigured,
    },
  });

  registry.registerPath({
    method: "post",
    path: `${SETTINGS}/domains/{domainId}/reconcile`,
    tags: TAGS,
    summary: "Adopt the provider's existing registration of a domain",
    description: "For a domain in `registration.status: needs_reconciliation`: finds the email provider's registration of the domain by name and records it for this workspace, or registers the domain afresh when the provider no longer holds it. Audited. A registered domain is returned unchanged.",
    operationId: "reconcileEmailDomain",
    security: sec,
    request: { params: DomainParams },
    responses: {
      200: { description: "Domain with its provider registration", content: json(email.EmailDomainSchema) },
      401: unauthenticated,
      403: settingsManageRequired,
      404: errorResponse("Domain not found"),
      409: errorResponse("`domain_not_awaiting_reconciliation` (the provider has not reported the domain as already registered) or `domain_removal_pending`: a removal of the domain is still being cleaned up at the provider"),
      502: errorResponse("`provider_unavailable`"),
      503: notConfigured,
    },
  });

  registry.registerPath({
    method: "post",
    path: `${SETTINGS}/domains/{domainId}/receiving`,
    tags: TAGS,
    summary: "Enable direct receiving on a domain",
    description: "Routes all of the domain's mail to Radioso. `confirmation` must equal the domain name.",
    operationId: "enableEmailDirectReceiving",
    security: sec,
    request: { params: DomainParams, body: body(email.EnableEmailDirectReceivingRequestSchema) },
    responses: {
      200: { description: "Domain with receiving requested", content: json(email.EmailDomainSchema) },
      400: errorResponse("`confirmation_mismatch`"),
      401: unauthenticated,
      403: settingsManageRequired,
      404: errorResponse("Domain not found"),
      409: errorResponse("`domain_needs_reconciliation`: reconcile the domain first"),
      502: errorResponse("`provider_unavailable`"),
      503: notConfigured,
    },
  });

  registry.registerPath({
    method: "delete",
    path: `${SETTINGS}/domains/{domainId}`,
    tags: TAGS,
    summary: "Remove a sending domain",
    description: "Revokes the domain's authority at once; the provider is cleaned up afterwards.",
    operationId: "removeEmailDomain",
    security: sec,
    request: { params: DomainParams },
    responses: {
      204: { description: "Domain removed" },
      401: unauthenticated,
      403: settingsManageRequired,
      404: errorResponse("Domain not found"),
      409: errorResponse("`domain_has_mailboxes`: remove the domain's mailboxes first"),
      503: notConfigured,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/conversations/{conversationId}/email",
    tags: TAGS,
    summary: "Read an email conversation's facts",
    description: "The mailbox, the participant, the latest subject and CC, sending readiness, the send budget and per-message facts.",
    operationId: "getConversationEmailFacts",
    security: sec,
    request: { params: ConversationParams },
    responses: {
      200: { description: "Email conversation facts", content: json(email.ConversationEmailFactsSchema) },
      400: errorResponse("Invalid conversation id"),
      401: unauthenticated,
      403: errorResponse("Workspace conversation takeover permission required"),
      404: errorResponse("Not an email conversation of this workspace"),
    },
  });
};
