export const staffRoles = ["support_read", "billing_write", "owner"] as const;
export type StaffRole = (typeof staffRoles)[number];

export const staffStatuses = ["active", "disabled"] as const;
export type StaffStatus = (typeof staffStatuses)[number];

export interface StaffUser {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
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
  revokedAt: Date | null;
}
