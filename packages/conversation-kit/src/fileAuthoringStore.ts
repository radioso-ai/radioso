import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  emptySnapshot,
  parseSnapshot,
  TransientConversationKitAuthoringStore,
  type ConversationKitAuthoringSnapshot,
} from "./authoringStore.js";

export interface FileConversationKitAuthoringStoreOptions {
  path: string;
}

const loadFileSnapshot = (path: string): ConversationKitAuthoringSnapshot => {
  if (!existsSync(path)) {
    return emptySnapshot();
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return parseSnapshot(parsed);
};

/**
 * A filesystem-backed authoring store. It lives apart from the in-memory store because
 * `node:fs` is the one thing in the kit that a Worker or browser runtime cannot provide,
 * and is published under `@radioso/conversation-kit/node` for the same reason.
 */
export class FileConversationKitAuthoringStore extends TransientConversationKitAuthoringStore {
  private readonly path: string;

  constructor(options: FileConversationKitAuthoringStoreOptions) {
    super(loadFileSnapshot(options.path));
    this.path = options.path;
  }

  protected override changed(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.exportSnapshot(), null, 2)}\n`, "utf8");
    renameSync(temporaryPath, this.path);
  }
}
