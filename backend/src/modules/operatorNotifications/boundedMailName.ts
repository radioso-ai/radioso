// Workspace and agent names are tenant-authored, so they are kept short enough that a system email
// naming them cannot carry a message of its own.
const NAME_MAX_LENGTH = 60;

/** One line, trimmed and cut to a length that cannot carry a message. */
export const boundedMailName = (value: string): string => {
  const line = value.replace(/[\r\n]+/gu, " ").trim();
  return line.length > NAME_MAX_LENGTH ? `${line.slice(0, NAME_MAX_LENGTH - 1).trimEnd()}…` : line;
};
