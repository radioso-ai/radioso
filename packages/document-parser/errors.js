export class DocumentParserError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DocumentParserError";
    this.code = code;
  }
}
