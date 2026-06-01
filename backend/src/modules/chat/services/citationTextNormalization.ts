export const removeDetachedPunctuationSpacing = (text: string): string =>
  text
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    // A removed anchor can leave its trailing punctuation or link list stranded on
    // its own line (e.g. `claim\n\n.` or `claim\n\n; link`). Pull punctuation that
    // a newline-bearing whitespace run now precedes back onto the prior line. Normal
    // prose never starts a paragraph with sentence punctuation, so genuine paragraph
    // breaks (newline followed by word content) are left intact.
    .replace(/[ \t]*\r?\n\s*([.,;:!?])/g, "$1")
    .replace(/[ \t]+(\r?\n)/g, "$1");
