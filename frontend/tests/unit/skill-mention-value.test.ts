/* @vitest-environment jsdom */

import { describe, expect, it } from 'vitest'

import { mentionsSkill, readSkillMentions, seedSkillMentionValue } from '@/components/dashboard/settings/skill-mention-input'

// The Action field of a directive is a string that round-trips through the API, and a `#name` in
// it is the directive's binding. The routine grammar reads every `#<identifier>` as a skill, so
// these two functions decide which of them the editor promotes to a chip — and therefore which
// bindings the host can end up saving. A `#word` an author merely wrote must stay prose.
describe('skill mention value', () => {
  describe('with nothing declared', () => {
    it('reports no mention for prose that happens to contain a #word', () => {
      const action = 'Point the customer at #billing for pricing questions.'
      expect(readSkillMentions(action)).toEqual([])
    })

    it('leaves that prose byte-identical', () => {
      const action = 'Point the customer at #billing for pricing questions.'
      expect(seedSkillMentionValue(action)).toBe(action)
    })

    it('keeps a #word that a declared name does not cover', () => {
      // Recognition comes from the declaration alone. Whether a skill named `billing` exists in
      // the agent's catalog is beside the point: the author did not write a chip.
      const action = 'Point the customer at #billing, then use #issue_refund'
      expect(readSkillMentions(action, ['issue_refund'])).toEqual(['issue_refund'])
      expect(seedSkillMentionValue(action, ['issue_refund'])).toBe(action)
    })

    it('keeps the binding suffix of an undeclared mention', () => {
      const action = 'Look it up with #billing[in query=@topic] first'
      expect(readSkillMentions(action)).toEqual([])
      expect(seedSkillMentionValue(action)).toBe(action)
    })

    it('leaves an @handle as prose', () => {
      const action = 'Escalate to @support when the customer is blocked.'
      expect(readSkillMentions(action)).toEqual([])
      expect(seedSkillMentionValue(action)).toBe(action)
    })

    it('leaves routine tokens as the characters they were written with', () => {
      const action = 'Wrap up -> end and note [if refunded is_true] on the record.'
      expect(readSkillMentions(action)).toEqual([])
      expect(seedSkillMentionValue(action)).toBe(action)
    })
  })

  describe('with a declared mention', () => {
    it('reports it', () => {
      const action = 'Refund the order using #issue_refund'
      expect(readSkillMentions(action, ['issue_refund'])).toEqual(['issue_refund'])
      expect(seedSkillMentionValue(action, ['issue_refund'])).toBe(action)
    })

    it('reads a value that is only the mention', () => {
      expect(readSkillMentions('#issue_refund', ['issue_refund'])).toEqual(['issue_refund'])
      expect(seedSkillMentionValue('#issue_refund', ['issue_refund'])).toBe('#issue_refund')
    })

    it('reports every occurrence, so a host can refuse a second one', () => {
      const action = 'Use #issue_refund, and if that fails use #issue_refund again'
      expect(readSkillMentions(action, ['issue_refund'])).toEqual(['issue_refund', 'issue_refund'])
      expect(seedSkillMentionValue(action, ['issue_refund'])).toBe(action)
    })

    it('carries its typed bindings through', () => {
      const action = 'Refund with #issue_refund[in order=@order_id]'
      expect(readSkillMentions(action, ['issue_refund'])).toEqual(['issue_refund'])
      expect(seedSkillMentionValue(action, ['issue_refund'])).toBe(action)
    })

    // An author writes the chip where the sentence needs it, which is often at the end. If the
    // period joined the name, the mention would name a skill nobody registered, the chip would
    // not seed, and a host that appends its binding would write a second copy into the
    // instruction the model reads.
    it('reads it through the punctuation that ends the sentence', () => {
      for (const action of [
        'Escalate using #issue_refund.',
        'Escalate using #issue_refund, then wait.',
        'Escalate using #issue_refund;',
        'Escalate using #issue_refund:',
        'Escalate using #issue_refund!',
        'Escalate using #issue_refund?',
        '#issue_refund.',
      ]) {
        expect(readSkillMentions(action, ['issue_refund'])).toEqual(['issue_refund'])
        // Seeding is a fixed point: opening a directive and saving it untouched must send back
        // the bytes that were stored.
        expect(seedSkillMentionValue(action, ['issue_refund'])).toBe(action)
      }
    })

    it('reads it at the very end of the value', () => {
      expect(readSkillMentions('Escalate using #issue_refund', ['issue_refund'])).toEqual(['issue_refund'])
      expect(seedSkillMentionValue('Escalate using #issue_refund', ['issue_refund'])).toBe('Escalate using #issue_refund')
    })
  })

  // `mentionsSkill` is what decides whether a host appends its binding to the action, and
  // `readSkillMentions` is what decides whether the editor seeds a chip for it. When the two read
  // the token's end differently, one of them is wrong on every save: either the host appends a
  // second copy of a mention the author already wrote, or it skips the append and the editor's
  // mount emit reports no chips, clearing the binding on a save the operator sees as a no-op.
  //
  // So they must be the same reader. `mentionsSkill(value, name)` is true exactly when
  // `readSkillMentions(value, [name])` contains `name`, and the table below pins both the
  // equivalence and the answer, over the continuations an identifier admits.
  describe('mentionsSkill agrees with readSkillMentions', () => {
    const skillName = 'issue_refund'
    const cases: [description: string, action: string, mentioned: boolean][] = [
      ['the name alone', '#issue_refund', true],
      ['at the end of the value', 'Escalate using #issue_refund', true],
      ['mid-sentence', '#issue_refund handles it', true],
      ['before the period that ends the sentence', 'Escalate using #issue_refund.', true],
      ['before a comma', 'Escalate using #issue_refund, then wait.', true],
      ['carrying a binding suffix', 'Escalate using #issue_refund[in order=@order_id]', true],
      ['written twice', 'Use #issue_refunds, or #issue_refund', true],
      // `.` and `-` extend an identifier, so these name other skills — not this one. The dropped
      // `-` was the drift that cleared bindings: the host read `#issue_refund-tier2` as this
      // mention, skipped the append, and the editor found nothing to seed.
      ['as a hyphenated longer name', 'Use #issue_refund-tier2 for escalations', false],
      ['as a dotted longer name', 'Use #issue_refund.tier2 for escalations', false],
      ['as an underscored longer name', 'Use #issue_refund_v2 instead', false],
      ['as a longer name ending in digits', 'Use #issue_refund2 instead', false],
      ['as a pluralised longer name', 'Use #issue_refunds for bulk orders', false],
      ['as a longer name at the end of the value', 'Use #issue_refund-tier2', false],
      // The bracket ends the name, so this token names `issue_refund.` and not this skill.
      ['behind punctuation that a binding suffix reaches', '#issue_refund.[in order=@order_id]', false],
      ['as a heading rather than a mention', '# issue_refund', false],
      ['as prose without the marker', 'Refunds are handled elsewhere', false],
      ['as an @handle rather than a #mention', 'Escalate to @issue_refund', false],
      ['nowhere in an empty value', '', false],
    ]

    it.each(cases)('%s', (_description, action, mentioned) => {
      expect(mentionsSkill(action, skillName)).toBe(mentioned)
      expect(readSkillMentions(action, [skillName]).includes(skillName)).toBe(mentioned)
    })

    it('answers no for an empty name', () => {
      expect(mentionsSkill('Escalate using #issue_refund.', '')).toBe(false)
    })
  })

  it('reads an empty value as no mentions and no text', () => {
    expect(readSkillMentions('')).toEqual([])
    expect(seedSkillMentionValue('')).toBe('')
    expect(readSkillMentions('', ['issue_refund'])).toEqual([])
  })

  describe('with line breaks', () => {
    const action = 'Answer in two sentences.\nThen escalate with #issue_refund.'

    it('seeds a value the author broke across lines byte-identically', () => {
      expect(seedSkillMentionValue(action, ['issue_refund'])).toBe(action)
    })

    it('finds a mention on any line, not only the first', () => {
      expect(readSkillMentions(action, ['issue_refund'])).toEqual(['issue_refund'])
      expect(mentionsSkill(action, 'issue_refund')).toBe(true)
    })

    it('keeps a blank line between two lines', () => {
      const spaced = 'First.\n\nSecond.'
      expect(seedSkillMentionValue(spaced)).toBe(spaced)
    })
  })
})
