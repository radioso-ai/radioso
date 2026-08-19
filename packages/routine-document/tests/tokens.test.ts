import { describe, expect, it } from 'vitest'

import { parseProseDoc, serializeProseDoc, tokenForChip, type ProseParagraph } from '../src/index.js'

// The inline chip token layer is what a skill-mention surface reads and writes: an author
// types `#skill` or `@variable` inside one field, and the stored value keeps those marks as
// literal text. The portable routine document that used to wrap these tokens is retired, so
// these tests pin the layer that outlived it.

const paragraphs = (doc: { paragraphs: ProseParagraph[] }) => doc.paragraphs

const parse = (text: string, isSkill: (name: string) => boolean = () => false) =>
  paragraphs(parseProseDoc(text, isSkill))

describe('inline chip tokens', () => {
  describe('tokenForChip', () => {
    it('writes a skill back as the `#name` an author typed', () => {
      expect(tokenForChip({ kind: 'chip', chipKind: 'skill', refId: 'book_demo', label: 'Book demo' })).toBe('#book_demo')
    })

    it('writes a variable back as the `@name` an author typed', () => {
      expect(tokenForChip({ kind: 'chip', chipKind: 'variable', refId: 'work_email', label: 'work email' })).toBe('@work_email')
    })

    it('keeps a skill chip whole when it carries input and output bindings', () => {
      const token = tokenForChip({
        kind: 'chip',
        chipKind: 'skill',
        refId: 'book_demo',
        label: 'Book demo',
        inputBindings: { email: { kind: 'variableRef', ref: 'work_email' } },
        outputAssignments: { booking: 'booking_id' },
      })
      // A mention surface rebuilds an unrecognized `#name` from its token, so nothing the
      // author bound may be dropped on the way back to text.
      expect(token).toContain('#book_demo')
      expect(token).toContain('work_email')
      expect(token).toContain('booking_id')
    })
  })

  describe('parseProseDoc', () => {
    // The grammar reads every `#<identifier>` as a skill chip. Deciding which of them a
    // given surface actually carries as a binding is the host's job, not the parser's —
    // a mention surface turns the rest back into the literal text the author wrote.
    it('reads every `#name` as a skill chip, declared or not', () => {
      const [paragraph] = parse('Send them to #billing for pricing.')
      expect(paragraph?.segments).toEqual([
        { kind: 'text', text: 'Send them to ' },
        { kind: 'chip', chipKind: 'skill', refId: 'billing', label: 'billing' },
        { kind: 'text', text: ' for pricing.' },
      ])
    })

    it('reads a `@name` as a variable chip', () => {
      const [paragraph] = parse('Ask for @work_email first.')
      const chip = paragraph?.segments.find((segment) => segment.kind === 'chip')
      expect(chip).toMatchObject({ kind: 'chip', chipKind: 'variable', refId: 'work_email' })
    })

    it('splits a multi-line value into one paragraph per line', () => {
      expect(parse('First line.\nSecond line.')).toHaveLength(2)
    })
  })

  it('round-trips prose with a recognized skill back to the same text', () => {
    const source = 'Ask for @work_email then call #book_demo.'
    const doc = parseProseDoc(source, (name) => name === 'book_demo')
    const written = serializeProseDoc({
      name: 'Book a demo',
      trigger: 'the visitor asks for a demo',
      variables: doc.variables,
      paragraphs: doc.paragraphs,
    })
    expect(written).toContain(source)
  })
})
