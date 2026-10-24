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
