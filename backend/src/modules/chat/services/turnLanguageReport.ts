import type { ChatStreamEvent } from "../contracts/streamEvents.js";
import { lazyPromise, type ChatTurnPlanHandle } from "./turnPlanCoordinator.js";

/**
 * The turn's response language as its stream reports it: the BCP 47 tag the turn's plan gives the
 * language the turn answers in. Reading it never starts the plan or the language detector.
 */
export interface TurnLanguageReport {
  /**
   * The tag, once the turn has read its response language: undefined when the language did not
   * come from the plan, or the plan gave no tag. Never settles on a turn that never reads it.
   */
  readonly tag: Promise<string | undefined>;
  /**
   * The response-language promise the turn's consumers read in place of `responseLanguage`: the
   * same lazy value, observed, so the report follows the first consumer that reads it.
   */
  observe(responseLanguage: Promise<string | undefined>, plan: ChatTurnPlanHandle | undefined): Promise<string | undefined>;
  /**
   * The turn has ended: a report whose language was never read settles with no tag, so a caller
   * reading the tag after the turn always gets an answer. A language that was read reports as usual.
   */
  close(): void;
}

const planTagOf = async (plan: ChatTurnPlanHandle): Promise<string | undefined> => {
  // The language was read, so the plan has been resolved already; this reads its memo.
  const outcome = await plan.resolve(null);
  return outcome.status === "planned" ? outcome.plan.responseLanguageTag : undefined;
};

export const createTurnLanguageReport = (): TurnLanguageReport => {
  let settle!: (tag: string | undefined) => void;
  let read = false;
  const tag = new Promise<string | undefined>((resolve) => {
    settle = resolve;
  });
  return {
    tag,
    close: () => {
      if (!read) settle(undefined);
    },
    observe: (responseLanguage, plan) =>
      lazyPromise(() =>
        responseLanguage.then(
          (language) => {
            read = true;
            if (language && plan) {
              void planTagOf(plan).then(settle, () => settle(undefined));
            } else {
              settle(undefined);
            }
            return language;
          },
          (error: unknown) => {
            read = true;
            settle(undefined);
            throw error;
          },
        )),
  };
};

/**
 * The turn's events with its response language reported once, as a `language` event with the tag
 * when there is one, as soon as the turn has read it: ahead of whatever the turn sends next, so a
 * channel learns the language before the answer's first chunk even while the turn is still
 * searching. A turn that never reads its language ends without the report.
 */
export async function* withTurnLanguageReport(
  events: AsyncIterable<ChatStreamEvent>,
  report: Pick<TurnLanguageReport, "tag">,
): AsyncGenerator<ChatStreamEvent> {
  const iterator = events[Symbol.asyncIterator]();
  let reported: Promise<{ kind: "language"; tag: string | undefined }> | null = report.tag.then((tag) => ({ kind: "language" as const, tag }));
  let pending: Promise<IteratorResult<ChatStreamEvent>> | undefined;
  let finished = false;
  try {
    for (;;) {
      pending ??= iterator.next();
      const next = reported
        ? await Promise.race([pending.then((step) => ({ kind: "event" as const, step })), reported])
        : { kind: "event" as const, step: await pending };
      if (next.kind === "language") {
        reported = null;
        yield next.tag ? { type: "language", tag: next.tag } : { type: "language" };
        continue;
      }
      pending = undefined;
      if (next.step.done) {
        finished = true;
        return;
      }
      yield next.step.value;
    }
  } finally {
    if (!finished) {
      await iterator.return?.();
    }
  }
}
