import { randomBytes } from "node:crypto";

export const generateEmailVerificationToken = (): string => randomBytes(24).toString("hex");
