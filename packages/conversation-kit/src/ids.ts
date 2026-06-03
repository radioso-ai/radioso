import { randomUUID } from "node:crypto";

export const createId = (prefix: string): string => `${prefix}_${randomUUID()}`;
