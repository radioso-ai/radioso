import type { Response } from "express";

type CompletionCallback = () => void | Promise<void>;

interface CompletionState {
  failed: boolean;
}

const responseStates = new WeakMap<Response, CompletionState>();

const stateFor = (res: Response): CompletionState => {
  const existing = responseStates.get(res);
  if (existing) {
    return existing;
  }

  const created = { failed: false };
  responseStates.set(res, created);
  return created;
};

export const markHttpResponseFailed = (res: Response): void => {
  stateFor(res).failed = true;
};

export const onSuccessfulHttpResponse = (res: Response, callback: CompletionCallback): void => {
  const state = stateFor(res);
  res.once("finish", () => {
    if (state.failed || res.statusCode < 200 || res.statusCode >= 300) {
      return;
    }

    try {
      void Promise.resolve(callback()).catch(() => undefined);
    } catch {
      // Usage persistence is diagnostic metadata and must not affect the completed response.
    }
  });
};
