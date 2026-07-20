import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

export const registerAuthPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "get",
    path: "/api/v1/auth/registration",
    tags: ["Auth"],
    summary: "Get registration availability",
    description: "Reports whether open organization-creating registration is currently available for this deployment.",
    operationId: "getRegistrationAvailability",
    responses: {
      200: {
        description: "Registration availability returned",
        content: {
          "application/json": {
            schema: schemas.RegistrationAvailabilityResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/auth/register",
    tags: ["Auth"],
    summary: "Register a new account",
    operationId: "registerAccount",
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.RegisterRequestSchema,
          },
        },
      },
    },
    responses: {
      201: {
        description: "Account created and verification required before sign-in",
        content: {
          "application/json": {
            schema: schemas.RegisterResponseSchema,
          },
        },
      },
      400: {
        description: "Request validation failed",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      403: {
        description: "Open registration is closed and an invitation is required",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      409: {
        description: "Resource already exists",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      500: {
        description: "Unexpected server error",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/auth/login",
    tags: ["Auth"],
    summary: "Log in an existing account",
    operationId: "loginAccount",
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.LoginRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Session established",
        content: {
          "application/json": {
            schema: schemas.LoginResponseSchema,
          },
        },
      },
      400: {
        description: "Request validation failed",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      401: {
        description: "Authentication required or invalid credentials",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      500: {
        description: "Unexpected server error",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/auth/password-reset/request",
    tags: ["Auth"],
    summary: "Request a password reset email",
    operationId: "requestPasswordReset",
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.PasswordResetRequestSchema,
          },
        },
      },
    },
    responses: {
      202: {
        description: "Password reset request accepted",
        content: {
          "application/json": {
            schema: schemas.AcceptedResponseSchema,
          },
        },
      },
      400: {
        description: "Request validation failed",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/auth/password-reset/confirm",
    tags: ["Auth"],
    summary: "Confirm password reset and establish a new session",
    operationId: "confirmPasswordReset",
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.PasswordResetConfirmRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Password reset confirmed and session established",
        content: {
          "application/json": {
            schema: schemas.PasswordResetConfirmResponseSchema,
          },
        },
      },
      400: {
        description: "Request validation failed",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      401: {
        description: "Reset token is invalid or expired",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/auth/email-verification/verify",
    tags: ["Auth"],
    summary: "Verify an email address",
    operationId: "verifyEmail",
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.EmailVerificationVerifyRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Email address verified",
        content: {
          "application/json": {
            schema: schemas.EmailVerificationVerifyResponseSchema,
          },
        },
      },
      400: {
        description: "Request validation failed",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      401: {
        description: "Verification token is invalid or expired",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/auth/email-verification/resend",
    tags: ["Auth"],
    summary: "Request an email verification email",
    operationId: "resendEmailVerification",
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.EmailVerificationResendRequestSchema,
          },
        },
      },
    },
    responses: {
      202: {
        description: "Email verification request accepted",
        content: {
          "application/json": {
            schema: schemas.AcceptedResponseSchema,
          },
        },
      },
      400: {
        description: "Request validation failed",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/auth/invitations/{invitationToken}",
    tags: ["Auth"],
    summary: "Get invitation details for an account join flow",
    operationId: "getAccountInvitation",
    request: {
      params: schemas.invitationTokenParamsSchema,
    },
    responses: {
      200: {
        description: "Invitation details returned",
        content: {
          "application/json": {
            schema: schemas.InvitationDetailsResponseSchema,
          },
        },
      },
      404: {
        description: "Invitation not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/auth/invitations/{invitationToken}/accept",
    tags: ["Auth"],
    summary: "Accept an invitation and establish a session for the joined account",
    operationId: "acceptAccountInvitation",
    request: {
      params: schemas.invitationTokenParamsSchema,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.InvitationAcceptRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Invitation accepted and session established",
        content: {
          "application/json": {
            schema: schemas.LoginResponseSchema,
          },
        },
      },
      401: {
        description: "Invitation email mismatch or invalid credentials",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Invitation not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      409: {
        description: "Invitation is no longer valid",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });
};
