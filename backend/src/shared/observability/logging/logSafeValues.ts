// Logs land in Cloud Logging, which conversation erasure cannot reach. A string from an event's
// own data reaches a log line only in one of these shapes, each of which rules out a person's words.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// A lowercase code such as `chat.turn` or `safe_test`: no spaces or capitals, so never a sentence.
const CODE_PATTERN = /^[a-z][a-z0-9_.:-]{0,63}$/u;

// A JavaScript class name such as `TypeError` or `DOMException`.
const CLASS_NAME_PATTERN = /^[A-Za-z_$][\w$.]{0,127}$/u;

export const isUuid = (value: string): boolean => UUID_PATTERN.test(value);

export const isCode = (value: string): boolean => CODE_PATTERN.test(value);

export const isClassName = (value: string): boolean => CLASS_NAME_PATTERN.test(value);

// One frame of a V8 stack, such as `    at Layer.handle [as handle_request] (/app/layer.js:95:5)`
// or `    at async Promise.all (index 0)`, or of a Firefox or Safari one, such as
// `render@/_next/static/chunks/app.js:3:4`. A frame names code and ends in a line and column or a
// V8 placeholder, so a line of an error's message, which a person's words may fill, never passes.
const V8_FRAME_PATTERN =
  /^\s*at (?:(?:async |new )?[\w$.<>]+(?: \[as [\w$.<>]+\])? \((?:[^\s()]+:\d+:\d+|<anonymous>|native|index \d+)\)|(?:async )?[^\s()]+:\d+:\d+)$/u;
const BROWSER_FRAME_PATTERN = /^[\w$.<>/]*@[^\s@]+:\d+:\d+$/u;

export const isStackFrame = (line: string): boolean => V8_FRAME_PATTERN.test(line) || BROWSER_FRAME_PATTERN.test(line);
