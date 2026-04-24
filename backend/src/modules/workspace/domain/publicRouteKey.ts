import { randomUUID } from "node:crypto";

const MAX_BASE_LENGTH = 24;

const normalizeBase = (name: string): string => {
  const normalized = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const trimmed = normalized.slice(0, MAX_BASE_LENGTH).replace(/-+$/g, "");
  return trimmed || "workspace";
};

export const createWorkspacePublicRouteKey = (
  name: string,
  generateId: () => string = randomUUID,
): string => {
  const base = normalizeBase(name);
  const suffix = generateId().replace(/-/g, "").slice(0, 6);
  return `${base}-${suffix}`;
};
