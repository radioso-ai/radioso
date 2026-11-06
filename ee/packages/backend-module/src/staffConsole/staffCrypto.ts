import { createHash, randomBytes } from "node:crypto";

import bcrypt from "bcryptjs";

const BCRYPT_COST = 12;

export const STAFF_PASSWORD_MIN_LENGTH = 12;

// Hashed once per process at the real cost, so an attempt against an address with no stored
// password spends the same bcrypt time as one against a real account.
let unusedPasswordHash: Promise<string> | undefined;
const resolveUnusedPasswordHash = (): Promise<string> =>
  (unusedPasswordHash ??= bcrypt.hash(randomBytes(32).toString("hex"), BCRYPT_COST));

export const hashStaffPassword = async (password: string): Promise<string> =>
  bcrypt.hash(password, BCRYPT_COST);

export const verifyStaffPassword = async (password: string, passwordHash: string | null): Promise<boolean> => {
  if (passwordHash === null) {
    await bcrypt.compare(password, await resolveUnusedPasswordHash());
    return false;
  }
  return bcrypt.compare(password, passwordHash);
};

export const generateStaffSessionToken = (): string =>
  randomBytes(32).toString("base64url");

export const hashStaffSessionToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");
