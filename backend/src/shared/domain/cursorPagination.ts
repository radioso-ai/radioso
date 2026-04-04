import { AppError } from "./errors.js";

export interface CursorPayload {
  version: 1;
  keys: Record<string, string>;
  totalSnapshot?: string;
}

export class CursorPaginationError extends AppError {
  constructor(message: string) {
    super(400, "bad_request", message);
    this.name = "CursorPaginationError";
  }
}

const CURSOR_VERSION = 1;

const encodeBase64Url = (value: string): string => Buffer.from(value, "utf8").toString("base64url");

const decodeBase64Url = (value: string): string => Buffer.from(value, "base64url").toString("utf8");

export const encodeCursor = (keys: Record<string, string>, totalSnapshot?: number): string =>
  encodeBase64Url(
    JSON.stringify({
      version: CURSOR_VERSION,
      keys,
      ...(totalSnapshot !== undefined ? { totalSnapshot: String(totalSnapshot) } : {}),
    } satisfies CursorPayload),
  );

export const decodeCursor = (cursor: string): CursorPayload => {
  try {
    const parsed = JSON.parse(decodeBase64Url(cursor)) as Partial<CursorPayload>;

    if (parsed.version !== CURSOR_VERSION) {
      throw new CursorPaginationError("Unsupported cursor version");
    }

    if (!parsed.keys || typeof parsed.keys !== "object" || Array.isArray(parsed.keys)) {
      throw new CursorPaginationError("Cursor payload is missing keys");
    }

    for (const [key, value] of Object.entries(parsed.keys)) {
      if (typeof key !== "string" || typeof value !== "string") {
        throw new CursorPaginationError("Cursor keys must be string pairs");
      }
    }

    if (parsed.totalSnapshot !== undefined && typeof parsed.totalSnapshot !== "string") {
      throw new CursorPaginationError("Cursor total snapshot must be a string");
    }

    return {
      version: CURSOR_VERSION,
      keys: parsed.keys,
      totalSnapshot: parsed.totalSnapshot,
    };
  } catch (error) {
    if (error instanceof CursorPaginationError) {
      throw error;
    }

    throw new CursorPaginationError("Invalid cursor");
  }
};
