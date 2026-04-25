import { randomUUID } from "node:crypto";

export const createWorkspacePublicRouteKey = (
  _name: string,
  generateId: () => string = randomUUID,
): string => {
  const digits = generateId()
    .replace(/\D/g, "")
    .padEnd(10, "0")
    .slice(0, 10);

  return digits;
};
