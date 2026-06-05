import {
  currentTraceCorrelation,
  safeSpanAttributes,
  setActiveSpanAttributes,
  startActiveSpan,
  streamActiveSpan,
} from "./index.js";
import type { ActiveTraceCorrelation } from "./index.js";

export type TraceAttributes = Record<string, unknown>;

export const traceOperation = async <T>(input: {
  name: string;
  attributes?: TraceAttributes;
  run: () => Promise<T> | T;
  resultAttributes?: (result: T) => TraceAttributes | undefined;
}): Promise<T> =>
  startActiveSpan(input.name, input.attributes, async (span) => {
    const result = await input.run();
    const finalAttributes = input.resultAttributes?.(result);
    if (finalAttributes) {
      const safeFinalAttributes = safeSpanAttributes(finalAttributes);
      const spanSink = span as { setAttributes?: (attributes: typeof safeFinalAttributes) => unknown } | undefined;
      if (spanSink?.setAttributes) {
        spanSink.setAttributes(safeFinalAttributes);
      } else {
        setActiveSpanAttributes(safeFinalAttributes);
      }
    }
    return result;
  }) as Promise<T>;

export const traceAsyncIterable = <T>(input: {
  name: string;
  attributes?: TraceAttributes;
  createIterable: () => AsyncIterable<T>;
}): AsyncIterable<T> =>
  streamActiveSpan(input.name, input.attributes, input.createIterable);

export const setTraceAttributes = (attributes: TraceAttributes): void => {
  setActiveSpanAttributes(attributes);
};

export const getActiveTraceCorrelation = (): ActiveTraceCorrelation | undefined =>
  currentTraceCorrelation();
