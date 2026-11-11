import { describe, expect, it } from 'vitest'

import { diffWords, WORD_DIFF_SIMILARITY_THRESHOLD } from '@/lib/word-diff'

const render = (diff: ReturnType<typeof diffWords>): string =>
  diff.segments
    .map((segment) => {
      if (segment.kind === 'removed') return `${segment.gap}[-${segment.text}-]`
      if (segment.kind === 'added') return `${segment.gap}{+${segment.text}+}`
      return `${segment.gap}${segment.text}`
    })
    .join('')

describe('diffWords', () => {
  it('reports identical texts as one unchanged run with full similarity', () => {
    const diff = diffWords('Keep answers short.', 'Keep answers short.')

    expect(diff.changes).toBe(0)
    expect(diff.similarity).toBe(1)
    expect(diff.segments).toEqual([{ kind: 'same', gap: '', text: 'Keep answers short.' }])
  })

  it('marks a replaced run as one removal and one addition', () => {
    const diff = diffWords(
      'Use bullets for options and bold labels only when they aid scanning.',
      'Use bullets for options and bold labels when there are more than two items.',
    )

    expect(render(diff)).toBe(
      'Use bullets for options and bold labels [-only-] when [-they aid scanning.-] {+there are more than two items.+}',
    )
    expect(diff.changes).toBe(3)
  })

  it('counts consecutive changed words as a single change', () => {
    const diff = diffWords('alpha beta gamma delta', 'alpha delta')

    expect(render(diff)).toBe('alpha [-beta gamma-] delta')
    expect(diff.changes).toBe(1)
  })

  it('keeps the whitespace the author wrote, including line breaks', () => {
    const diff = diffWords('First line.\nSecond line.', 'First line.\nSecond line changed.')

    expect(render(diff)).toBe('First line.\nSecond [-line.-] {+line changed.+}')
  })

  it('measures similarity as the share of words the longer text holds in common', () => {
    const diff = diffWords('one two three four', 'one two three four five six seven eight')

    expect(diff.similarity).toBe(0.5)
    expect(diff.similarity).toBeGreaterThanOrEqual(WORD_DIFF_SIMILARITY_THRESHOLD)
  })

  it('reports unrelated texts as dissimilar', () => {
    const diff = diffWords('Quote prices from the price list.', 'Greet every visitor warmly and ask their name.')

    expect(diff.similarity).toBeLessThan(WORD_DIFF_SIMILARITY_THRESHOLD)
  })

  it('treats two empty texts as identical and an empty side as fully different', () => {
    expect(diffWords('', '  ').similarity).toBe(1)
    expect(diffWords('', 'something new').similarity).toBe(0)
    expect(diffWords('something old', '').similarity).toBe(0)
  })

  it('declines to compare texts too long to diff cheaply', () => {
    const long = Array.from({ length: 2500 }, (_, index) => `word${index}`).join(' ')
    const diff = diffWords(long, `${long} extra`)

    expect(diff.similarity).toBe(0)
    expect(diff.segments).toEqual([])
  })
})
