import { randomBytes } from "node:crypto";

export const generatePasswordResetToken = (): string => randomBytes(24).toString("hex");
