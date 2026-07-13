import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { canonicalize, parse } from '../src/index.js'

type Example = {
  key: string
  section: string
  language: string
  body: string
}

const docPath = resolve(import.meta.dirname, '../../../docs/portable-routine-markdown.md')

const extractExamples = (): Example[] => {
  const source = readFileSync(docPath, 'utf8')
  const examples: Example[] = []
  let section = 'Document'
  let ordinalBySection = new Map<string, number>()
  let inFence = false
  let fenceLanguage = ''
  let fenceLines: string[] = []

  for (const line of source.split('\n')) {
    const heading = /^(#{2,3})\s+(.+)$/.exec(line)
    if (!inFence && heading) {
      section = heading[2]!
      continue
    }
    const fence = /^```(\w*)\s*$/.exec(line)
    if (fence && !inFence) {
      inFence = true
      fenceLanguage = fence[1] ?? ''
      fenceLines = []
      continue
    }
    if (line === '```' && inFence) {
      const ordinal = (ordinalBySection.get(section) ?? 0) + 1
      ordinalBySection = new Map(ordinalBySection).set(section, ordinal)
      examples.push({
        key: `${section} #${ordinal}`,
        section,
        language: fenceLanguage,
        body: fenceLines.join('\n'),
      })
      inFence = false
      continue
    }
    if (inFence) fenceLines.push(line)
  }

  return examples
}

describe('portable routine markdown docs conformance', () => {
  const examples = extractExamples()

  it('keeps the conformance test keyed to every fenced example in the normative doc', () => {
    expect(examples.map((example) => `${example.key} [${example.language}]`)).toEqual([
      'Document Shape #1 [md]',
      'Inline Tokens #1 [md]',
      'Guards #1 [md]',
      'Guards #2 [md]',
      'Guards #3 [md]',
      'Jumps And Terminals #1 [md]',
      'Decision And Approval Gates #1 [md]',
      'Decision And Approval Gates #2 [md]',
      'Completion Export #1 [md]',
    ])
  })

  for (const example of examples) {
    it(`validates docs example: ${example.key}`, () => {
      if (example.language === 'md') {
        const result = example.body.startsWith('---')
          ? parse(example.body, { resolveSkill: (name) => name.includes('.') })
          : canonicalize(example.body, { resolveSkill: (name) => name.includes('.') })
        expect(result.ok).toBe(true)
      } else if (example.language === 'json') {
        expect(() => JSON.parse(example.body)).not.toThrow()
      } else {
        expect(example.body.trim().length).toBeGreaterThan(0)
      }
    })
  }
})
