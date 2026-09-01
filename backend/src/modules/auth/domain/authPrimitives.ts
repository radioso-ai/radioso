import { randomBytes, createCipheriv, createDecipheriv, createHash, scryptSync } from "node:crypto";

import bcrypt from "bcryptjs";
import { serialize } from "cookie";

import type { Env } from "../../../app/config/env.js";

const TOKEN_PREFIX = "radioso_";

const deriveKey = (secret: string): Buffer => scryptSync(secret, "radioso-auth", 32);

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const deriveOrganizationName = (email: string): string => {
  const localPart = normalizeEmail(email).split("@")[0] ?? "";
  const normalized = localPart.replace(/[._+-]+/g, " ").trim();
  const words = normalized
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));

  const label = words.join(" ").trim();
  return `${label.length > 0 ? label : "My"} Organization`;
};

export const hashPassword = async (password: string): Promise<string> => bcrypt.hash(password, 12);

export const verifyPassword = async (password: string, passwordHash: string): Promise<boolean> =>
  bcrypt.compare(password, passwordHash);

export const generateSessionToken = (): string => randomBytes(32).toString("hex");

export const generateApiToken = (): string => `${TOKEN_PREFIX}${randomBytes(24).toString("hex")}`;

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export const encryptSecret = (value: string, secret: string): string => {
  const iv = randomBytes(12);
  const key = deriveKey(secret);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
};

export const decryptSecret = (value: string, secret: string): string => {
  const [ivHex, tagHex, encryptedHex] = value.split(":");
  const key = deriveKey(secret);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
};

export const serializeSessionCookie = (sessionToken: string, env: Env): string =>
  serialize(env.SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: env.SESSION_TTL_HOURS * 60 * 60,
  });

export const tokenPrefix = (token: string): string => token.slice(0, TOKEN_PREFIX.length + 8);
