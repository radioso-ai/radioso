import { z } from "zod";

const label = z.string().min(1).max(80);
const expiry = z.string().datetime().transform((value) => new Date(value));

export const apiAccessWorkspaceParamsSchema = z.object({ workspaceId: z.string().uuid() });
export const apiAccessServiceAccountParamsSchema = apiAccessWorkspaceParamsSchema.extend({ serviceAccountId: z.string().uuid() });
export const personalCredentialIssueSchema = z.object({ label, roleCeiling: z.enum(["member", "admin"]), expiresAt: expiry });
export const serviceAccountCreateSchema = z.object({ displayName: label, role: z.enum(["member", "admin"]), credentialExpiresAt: expiry });
export const serviceCredentialIssueSchema = z.object({ label, expiresAt: expiry });
export const credentialUpdateSchema = z.object({ label, revision: z.number().int().positive() });
export const credentialRotateSchema = z.object({ revision: z.number().int().positive() });
export const serviceAccountUpdateSchema = z.object({
  displayName: label.optional(),
  role: z.enum(["member", "admin"]).optional(),
  revision: z.number().int().positive(),
}).refine((value) => value.displayName !== undefined || value.role !== undefined);
export const lifecycleRevisionSchema = z.object({ revision: z.number().int().positive() });
export const apiAccessCredentialParamsSchema = apiAccessWorkspaceParamsSchema.extend({ credentialId: z.string().uuid() });
export const apiAccessServiceCredentialParamsSchema = apiAccessServiceAccountParamsSchema.extend({ credentialId: z.string().uuid() });
export const apiAccessPageQuerySchema = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(50), view: z.enum(["mine", "workspace"]).default("mine") });
