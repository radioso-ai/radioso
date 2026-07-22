const findJsonStringEnd = (value: string, openingQuoteIndex: number): number => {
  let escaped = false;
  for (let index = openingQuoteIndex + 1; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      return index;
    }
  }
  return -1;
};

const findTopLevelStringFieldStart = (raw: string, field: string): number | null => {
  const containers: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === "{" || character === "[") {
      containers.push(character);
      continue;
    }
    if (character === "}" || character === "]") {
      containers.pop();
      continue;
    }
    if (character !== '"') {
      continue;
    }
    const end = findJsonStringEnd(raw, index);
    if (end === -1) {
      return null;
    }
    if (containers.length === 1 && containers[0] === "{") {
      let cursor = end + 1;
      while (/\s/.test(raw[cursor] ?? "")) cursor += 1;
      if (raw[cursor] === ":") {
        const token = raw.slice(index, end + 1);
        let key: unknown;
        try {
          key = JSON.parse(token);
        } catch {
          return null;
        }
        cursor += 1;
        while (/\s/.test(raw[cursor] ?? "")) cursor += 1;
        if (key === field && raw[cursor] === '"') {
          return cursor + 1;
        }
      }
    }
    index = end;
  }
  return null;
};

const decodeJsonStringPrefix = (raw: string, start: number): string => {
  let value = "";
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === '"') {
      return value;
    }
    if (character !== "\\") {
      value += character;
      continue;
    }
    const escape = raw[index + 1];
    if (escape === undefined) {
      return value;
    }
    const simpleEscapes: Record<string, string> = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    if (escape in simpleEscapes) {
      value += simpleEscapes[escape];
      index += 1;
      continue;
    }
    if (escape === "u") {
      const hex = raw.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        return value;
      }
      value += String.fromCharCode(Number.parseInt(hex, 16));
      index += 5;
      continue;
    }
    return value;
  }
  return value;
};

/** Incrementally decodes one top-level JSON string field without exposing the
 * surrounding structured response. The full raw object stays available for the
 * terminal schema parser. */
export class StructuredAnswerFieldReader {
  private rawValue = "";
  private emittedLength = 0;
  private decodedAnswer = "";

  push(chunk: string): string {
    this.rawValue += chunk;
    const start = findTopLevelStringFieldStart(this.rawValue, "answer");
    if (start === null) {
      return "";
    }
    this.decodedAnswer = decodeJsonStringPrefix(this.rawValue, start);
    const delta = this.decodedAnswer.slice(this.emittedLength);
    this.emittedLength = this.decodedAnswer.length;
    return delta;
  }

  get raw(): string {
    return this.rawValue;
  }

  get answer(): string {
    return this.decodedAnswer;
  }
}
