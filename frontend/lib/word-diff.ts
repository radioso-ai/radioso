type DiffSegment = {
  kind: 'same' | 'removed' | 'added'
  // The whitespace that preceded the run in the text it came from, kept apart from `text` so a
  // renderer can highlight the words without highlighting the space (or line break) before them.
  gap: string
  text: string
}

export type WordDiff = {
  segments: DiffSegment[]
  // Edited stretches: a run of removed and added words between unchanged ones counts once, so a
  // word swapped for another is one change.
  changes: number
  // Words the two texts share, as a share of the longer text. 1 is identical, 0 is unrelated.
  similarity: number
}

// Two texts this similar read better as a diff than as two separate blocks.
export const WORD_DIFF_SIMILARITY_THRESHOLD = 0.5

// The comparison fills a words-by-words table, so its cost grows with the product of the two
// lengths. Past this a comparison is not worth the wait, and the caller shows both texts plainly.
const MAX_COMPARISON_CELLS = 1_000_000

type Token = { gap: string; word: string }

// Whitespace is the only delimiter. Language-specific word boundaries would make the diff
// disagree with itself across the languages operators write instructions in.
const tokenize = (text: string): Token[] =>
  Array.from(text.matchAll(/(\s*)(\S+)/g), (match) => ({ gap: match[1], word: match[2] }))

type Operation = { kind: DiffSegment['kind']; token: Token }

const compareTokens = (from: Token[], to: Token[]): { operations: Operation[]; shared: number } => {
  const rows = from.length
  const columns = to.length
  // table[i][j] is how many words `from[i..]` and `to[j..]` share in order.
  const table = Array.from({ length: rows + 1 }, () => new Int32Array(columns + 1))
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = columns - 1; j >= 0; j--) {
      table[i][j] = from[i].word === to[j].word
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  const operations: Operation[] = []
  let i = 0
  let j = 0
  while (i < rows && j < columns) {
    if (from[i].word === to[j].word) {
      // The kept word keeps the whitespace it has in the newer text.
      operations.push({ kind: 'same', token: to[j] })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      operations.push({ kind: 'removed', token: from[i++] })
    } else {
      operations.push({ kind: 'added', token: to[j++] })
    }
  }
  while (i < rows) operations.push({ kind: 'removed', token: from[i++] })
  while (j < columns) operations.push({ kind: 'added', token: to[j++] })
  return { operations, shared: table[0][0] }
}

const groupOperations = (operations: Operation[]): DiffSegment[] => {
  const segments: DiffSegment[] = []
  for (const { kind, token } of operations) {
    const last = segments[segments.length - 1]
    if (last?.kind === kind) {
      last.text += `${token.gap}${token.word}`
    } else {
      segments.push({ kind, gap: token.gap, text: token.word })
    }
  }
  return segments
}

export const diffWords = (from: string, to: string): WordDiff => {
  const fromTokens = tokenize(from)
  const toTokens = tokenize(to)
  const longest = Math.max(fromTokens.length, toTokens.length)
  if (longest === 0) return { segments: [], changes: 0, similarity: 1 }
  if (fromTokens.length * toTokens.length > MAX_COMPARISON_CELLS) {
    return { segments: [], changes: 0, similarity: 0 }
  }

  const { operations, shared } = compareTokens(fromTokens, toTokens)
  const segments = groupOperations(operations)
  return {
    segments,
    changes: segments.filter((segment, index) => segment.kind !== 'same' && (index === 0 || segments[index - 1].kind === 'same')).length,
    similarity: shared / longest,
  }
}
