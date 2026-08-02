import { appendFileSync } from "node:fs";

// Module-resolution hook for entryPoints.test.ts. Runs on Node's loader thread, which
// shares no memory with the main thread, so resolved specifiers go out through a file.
// This module's own imports are resolved before the hook is installed, so they are not
// recorded.
let sink = "";

export const initialize = (data) => {
  sink = data.sink;
};

export const resolve = async (specifier, context, next) => {
  if (sink) {
    appendFileSync(sink, `${specifier}\n`);
  }
  return next(specifier, context);
};
