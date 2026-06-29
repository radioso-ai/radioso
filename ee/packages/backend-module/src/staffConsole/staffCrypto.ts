import { createHash, randomBytes } from "node:crypto";

import * as bcrypt from "bcryptjs";

const BCRYPT_COST = 12;

export const hashStaffPassword = async (password: string): Promise<string> =>
  bcrypt.hash(password, BCRYPT_COST);

export const verifyStaffPassword = async (password: string, passwordHash: string): Promise<boolean> =>
  bcrypt.compare(password, passwordHash);

export const generateStaffSessionToken = (): string =>
  randomBytes(32).toString("base64url");

export const hashStaffSessionToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");
