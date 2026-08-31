import { z } from "zod";
import {
  emailVerificationResendSchema,
  emailVerificationVerifySchema,
  invitationAcceptSchema,
  invitationTokenParamsSchema,
  loginSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  registerSchema,
} from "../../routes/authRoutes.js";
import {
  accountInvitationParamsSchema,
  accountMembershipParamsSchema,
  accountSwitchSchema,
  createAccountSchema,
  createAccountInvitationSchema,
  updateMembershipRoleSchema,
  workspaceGrantParamsSchema,
  workspaceGrantSchema,
} from "../../routes/accountUserRoutes.js";
import {
  createWorkspaceSchema,
  renameWorkspaceSchema,
  workspaceKeyParamsSchema,
  workspaceParamsSchema,
} from "../../routes/workspaceRoutes.js";
import { workspaceMcpContextSchema } from "../../mcpContextSupport.js";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

export const registerIdentitySchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  const RegistrationAvailabilityResponseSchema = registry.register(
    "RegistrationAvailabilityResponse",
    z.object({ available: z.boolean() }),
  );
  const RegisterResponseSchema = registry.register(
    "RegisterResponse",
    z.object({
      userId: z.string().uuid(),
      accountId: z.string().uuid(),
      organizationName: z.string(),
      workspaceId: z.string().uuid(),
      workspaceName: z.string(),
      workspacePublicRouteKey: z.string(),
      requiresEmailVerification: z.boolean(),
    }),
  );

  const LoginResponseSchema = registry.register(
    "LoginResponse",
    z.object({
      userId: z.string().uuid(),
      accountId: z.string().uuid(),
      organizationName: z.string(),
      workspaceId: z.string().uuid(),
      workspaceName: z.string(),
      workspacePublicRouteKey: z.string(),
    }),
  );

  const AcceptedResponseSchema = registry.register(
    "AcceptedResponse",
    z.object({
      accepted: z.literal(true),
    }),
  );

  const PasswordResetConfirmResponseSchema = registry.register(
    "PasswordResetConfirmResponse",
    LoginResponseSchema.extend({
      email: z.string().email(),
    }),
  );

  const EmailVerificationVerifyResponseSchema = registry.register(
    "EmailVerificationVerifyResponse",
    z.object({
      verified: z.literal(true),
    }),
  );

  const WorkspaceSchema = registry.register(
    "Workspace",
    z.object({
      id: z.string().uuid(),
      accountId: z.string().uuid(),
      name: z.string(),
      publicRouteKey: z.string(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  );

  const WorkspaceRouteResolutionResponseSchema = registry.register(
    "WorkspaceRouteResolutionResponse",
    z.object({
      workspaceKey: z.string(),
      workspaceId: z.string().uuid(),
      workspaceName: z.string(),
      accountId: z.string().uuid(),
      organizationName: z.string(),
      realtimeEnabled: z.boolean(),
    }),
  );

  const WorkspaceListResponseSchema = registry.register(
    "WorkspaceListResponse",
    z.object({
      workspaces: z.array(WorkspaceSchema),
    }),
  );

  const WorkspaceSummaryResponseSchema = registry.register(
    "WorkspaceSummaryResponse",
    z.object({
      documentCount: z.number().int().min(0),
      readyDocumentCount: z.number().int().min(0),
      pendingDocumentCount: z.number().int().min(0),
      sampleDocumentCount: z.number().int().min(0),
      sampleDocumentSlugs: z.array(z.string()),
      conversationCount: z.number().int().min(0),
      hasDocuments: z.boolean(),
      hasPendingDocuments: z.boolean(),
      hasReadyDocuments: z.boolean(),
      hasCompletedChat: z.boolean(),
      sampleDocumentsImported: z.boolean(),
      websiteCrawlerEnabled: z.boolean(),
    }),
  );

  const WorkspaceMcpContextResponseSchema = registry.register(
    "WorkspaceMcpContextResponse",
    workspaceMcpContextSchema,
  );

  const RegisterRequestSchema = registry.register("RegisterRequest", registerSchema);
  const CreateAccountRequestSchema = registry.register("CreateAccountRequest", createAccountSchema);
  const LoginRequestSchema = registry.register("LoginRequest", loginSchema);
  const PasswordResetRequestSchema = registry.register("PasswordResetRequest", passwordResetRequestSchema);
  const PasswordResetConfirmRequestSchema = registry.register("PasswordResetConfirmRequest", passwordResetConfirmSchema);
  const EmailVerificationVerifyRequestSchema = registry.register("EmailVerificationVerifyRequest", emailVerificationVerifySchema);
  const EmailVerificationResendRequestSchema = registry.register("EmailVerificationResendRequest", emailVerificationResendSchema);
  const InvitationAcceptRequestSchema = registry.register("InvitationAcceptRequest", invitationAcceptSchema);
  const AccountInvitationCreateRequestSchema = registry.register("AccountInvitationCreateRequest", createAccountInvitationSchema);
  const AccountMembershipRoleUpdateRequestSchema = registry.register("AccountMembershipRoleUpdateRequest", updateMembershipRoleSchema);
  const WorkspaceGrantRequestSchema = registry.register("WorkspaceGrantRequest", workspaceGrantSchema);
  const WorkspaceCreateRequestSchema = registry.register("WorkspaceCreateRequest", createWorkspaceSchema);
  const WorkspaceRenameRequestSchema = registry.register("WorkspaceRenameRequest", renameWorkspaceSchema);

  const AccountUserSchema = registry.register(
    "AccountUser",
    z.object({
      membershipId: z.string().uuid(),
      userId: z.string().uuid(),
      email: z.string().email(),
      role: z.enum(["owner", "admin", "member"]),
      status: z.literal("active"),
      createdAt: z.string().datetime(),
    }),
  );

  const AccountInvitationSchema = registry.register(
    "AccountInvitation",
    z.object({
      id: z.string().uuid(),
      email: z.string().email(),
      status: z.enum(["pending", "accepted", "revoked", "expired"]),
      role: z.enum(["admin", "member"]),
      expiresAt: z.string().datetime(),
      acceptedAt: z.string().datetime().nullable(),
      createdAt: z.string().datetime(),
    }),
  );

  const WorkspaceGrantSchema = registry.register(
    "WorkspaceGrant",
    z.object({
      workspaceId: z.string().uuid(),
      userId: z.string().uuid(),
      role: z.enum(["admin", "member"]),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  );

  const AccountUsersResponseSchema = registry.register(
    "AccountUsersResponse",
    z.object({
      accountId: z.string().uuid(),
      currentUserId: z.string().uuid(),
      users: z.array(AccountUserSchema),
      invitations: z.array(AccountInvitationSchema),
      workspaceGrants: z.array(WorkspaceGrantSchema),
    }),
  );

  const AccessibleAccountSchema = registry.register(
    "AccessibleAccount",
    z.object({
      accountId: z.string().uuid(),
      organizationName: z.string(),
      role: z.enum(["owner", "admin", "member"]),
      workspaceId: z.string().uuid(),
      workspaceName: z.string(),
      workspacePublicRouteKey: z.string(),
    }),
  );

  const AccessibleAccountsResponseSchema = registry.register(
    "AccessibleAccountsResponse",
    z.object({
      currentAccountId: z.string().uuid(),
      accounts: z.array(AccessibleAccountSchema),
    }),
  );

  const CreateAccountInvitationResponseSchema = registry.register(
    "CreateAccountInvitationResponse",
    AccountInvitationSchema.extend({
      acceptanceUrl: z.string(),
    }),
  );

  const InvitationDetailsResponseSchema = registry.register(
    "InvitationDetailsResponse",
    z.object({
      accountId: z.string().uuid(),
      email: z.string().email(),
      status: z.enum(["pending", "accepted", "revoked", "expired"]),
      expiresAt: z.string().datetime(),
    }),
  );

  Object.assign(schemas, {
    accountInvitationParamsSchema,
    accountMembershipParamsSchema,
    accountSwitchSchema,
    RegistrationAvailabilityResponseSchema,
    RegisterResponseSchema,
    LoginResponseSchema,
    AcceptedResponseSchema,
    PasswordResetConfirmResponseSchema,
    EmailVerificationVerifyResponseSchema,
    WorkspaceSchema,
    WorkspaceRouteResolutionResponseSchema,
    WorkspaceListResponseSchema,
    WorkspaceSummaryResponseSchema,
    WorkspaceMcpContextResponseSchema,
    RegisterRequestSchema,
    CreateAccountRequestSchema,
    LoginRequestSchema,
    PasswordResetRequestSchema,
    PasswordResetConfirmRequestSchema,
    EmailVerificationVerifyRequestSchema,
    EmailVerificationResendRequestSchema,
    InvitationAcceptRequestSchema,
    AccountInvitationCreateRequestSchema,
    AccountMembershipRoleUpdateRequestSchema,
    WorkspaceGrantRequestSchema,
    WorkspaceCreateRequestSchema,
    WorkspaceRenameRequestSchema,
    AccountUserSchema,
    AccountInvitationSchema,
    WorkspaceGrantSchema,
    AccountUsersResponseSchema,
    AccessibleAccountSchema,
    AccessibleAccountsResponseSchema,
    CreateAccountInvitationResponseSchema,
    InvitationDetailsResponseSchema,
    invitationTokenParamsSchema,
    workspaceGrantParamsSchema,
    workspaceKeyParamsSchema,
    workspaceParamsSchema,
  });
};
