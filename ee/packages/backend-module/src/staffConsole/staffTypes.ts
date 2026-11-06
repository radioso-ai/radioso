export const staffRoles = ["support_read", "billing_write", "owner"] as const;
export type StaffRole = (typeof staffRoles)[number];

export const staffStatuses = ["active", "disabled"] as const;
export type StaffStatus = (typeof staffStatuses)[number];

export interface StaffUser {
  id: string;
  email: string;
  name: string;
  /** Null for staff who sign in with Google Workspace. */
  passwordHash: string | null;
  /** The Google account (`sub`) bound at first Workspace sign-in. */
  googleSubject: string | null;
  role: StaffRole;
  status: StaffStatus;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
}

export interface StaffSession {
  id: string;
  staffId: string;
  sessionTokenHash: string;
  expiresAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
}
