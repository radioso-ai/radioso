import type { TestExecutionEvent } from './api-agent-revisions'

/**
 * Reads a Test Chat turn's `text/event-stream`, handing each event to `onEvent` as it arrives.
 * Answers whether the stream reached the execution's terminal event.
 */
export const parseEvents = async (
  response: Response,
  onEvent: (event: TestExecutionEvent) => void,
): Promise<boolean> => {
  const reader = response.body?.getReader();
  if (!reader) return false;
  const decoder = new TextDecoder();
  let buffer = "";
  let sawExecutionTerminal = false;
  const parseFrame = (frame: string) => {
    const data = frame
      .split("\n")
      .find((line) => line.startsWith("data:"))
      ?.slice(5)
      .trim();
    if (!data) return;
    try {
      const event = JSON.parse(data) as TestExecutionEvent;
      if (
        event.type === "execution_completed" ||
        event.type === "execution_partial"
      )
        sawExecutionTerminal = true;
      onEvent(event);
    } catch {
      /* malformed event is ignored; server completion remains authoritative */
    }
  };
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      if (buffer.trim()) parseFrame(buffer);
      return sawExecutionTerminal;
    }
    buffer += decoder.decode(result.value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) parseFrame(frame);
  }
};
