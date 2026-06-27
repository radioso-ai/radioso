// Canonical plain-text grammar for a routine's prose, so the chip editor can copy to an
// external file and paste back without losing structure. The Lexical chip nodes already
// round-trip in-app via their JSON clipboard flavour; this grammar is what survives the
// text/plain (and text/html) flavours an external app like Notes keeps — every chip
// becomes a readable token, and parsing the tokens rebuilds the chips.
//
// The token spellings deliberately mirror the backend routine-document grammar
// (`backend/.../routines/document`) so the two surfaces stay one grammar: `@ref` mentions,
// `-> #step` / end targets, and bracketed guards. Keep them in sync when either moves.

import { OUTCOME_GUARD_REF } from './routine-prose'
import type {
  ApprovalDocOption,
  ChipDocVariable,
  ProseChipKind,
  ProseParagraph,
  ProseSegment,
  RoutineInputBinding,
  RoutineStepMode,
} from './routine-prose'
import type { RoutineFieldGuardOp, RoutineFieldGuardUnit, RoutineSlotType } from './api-types'

export type RoutineFieldGuardValue = string | number | boolean

export type ParsedProseDoc = {
  name: string | null
  trigger: string | null
  variables: ChipDocVariable[]
  paragraphs: ProseParagraph[]
  // True only when the text opened with our fenced frontmatter carrying a recognized
  // routine key (name/trigger/vars). This is the signal that the paste is a whole routine
  // and may replace the document — a bare leading `---` (e.g. a markdown doc) is not.
  hadFrontmatter: boolean
}

// The chip fields the token serializer reads. Both a ProseSegment chip and a live
// ChipNode project onto this, so copy (node) and serialize (segment) share one encoder.
export type ChipTokenInput = {
  chipKind: ProseChipKind
  refId: string
  op?: RoutineFieldGuardOp | null
  value?: RoutineFieldGuardValue | null
  values?: RoutineFieldGuardValue[] | null
  unit?: RoutineFieldGuardUnit | null
  counterLimit?: number | null
  inputBindings?: Record<string, RoutineInputBinding>
  outputAssignments?: Record<string, string>
  mode?: RoutineStepMode | null
  // Approval / decision gates: the captured slot and the choices (each with an optional
  // description, and — for the block `approval` form — a routing target).
  captureKey?: string | null
  options?: ApprovalDocOption[]
}

// The frontmatter fence and the readable comparison operators. The operator tokens are
// matched longest-first on parse so `>=` wins over `>` and `is true` over `is`.
const FENCE = '---'
const SLOT_TYPES: readonly RoutineSlotType[] = ['text', 'number', 'boolean', 'email', 'date']
const GUARD_UNITS: readonly RoutineFieldGuardUnit[] = ['days', 'weeks', 'months', 'years']

const OP_TOKENS: Record<RoutineFieldGuardOp, string> = {
  is_true: 'is true',
  is_false: 'is false',
  is_present: 'is present',
  is_absent: 'is absent',
  equals: '=',
  not_equals: '!=',
  in: 'in',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  older_than: 'older than',
  within: 'within',
}

// Longest token first so multi-word / multi-char operators win the match.
const OP_ENTRIES: Array<[RoutineFieldGuardOp, string]> = (Object.entries(OP_TOKENS) as Array<[RoutineFieldGuardOp, string]>)
  .sort((left, right) => right[1].length - left[1].length)

const opNeedsValue = (op: RoutineFieldGuardOp): boolean =>
  op !== 'is_true' && op !== 'is_false' && op !== 'is_present' && op !== 'is_absent'

const opNeedsUnit = (op: RoutineFieldGuardOp): boolean => op === 'older_than' || op === 'within'

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

const formatLiteral = (value: RoutineFieldGuardValue): string =>
  typeof value === 'string' ? value : String(value)

const escapeQuoted = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

const unescapeQuoted = (value: string): string =>
  value.replace(/\\(.)/g, '$1')

const BARE_ACTION_REF = /^[A-Za-z_][A-Za-z0-9_.-]*$/

const formatBinding = (binding: RoutineInputBinding): string =>
  binding.kind === 'variableRef' ? `@${binding.ref}` : formatLiteral(binding.value)

// A skill chip carries optional typed bindings (spec 090). They have no inline form in
// prose, so they ride in a bracket suffix that only appears when non-default — an unbound
// skill stays a clean `@skill_name`.
const formatSkillSuffix = (chip: ChipTokenInput): string => {
  const sections: string[] = []
  const inputs = Object.entries(chip.inputBindings ?? {})
  if (inputs.length > 0) {
    sections.push(`in ${inputs.map(([name, binding]) => `${name}=${formatBinding(binding)}`).join(', ')}`)
  }
  const outputs = Object.entries(chip.outputAssignments ?? {})
  if (outputs.length > 0) {
    sections.push(`out ${outputs.map(([name, ref]) => `${name}=@${ref}`).join(', ')}`)
  }
  if (chip.mode && chip.mode !== 'typed') {
    sections.push(`mode ${chip.mode}`)
  }
  return sections.length > 0 ? `[${sections.join('; ')}]` : ''
}

const formatConditionToken = (chip: ChipTokenInput): string => {
  // An outcome guard is a condition chip with the sentinel ref; its status rides in `value`.
  if (chip.refId === OUTCOME_GUARD_REF) return `[outcome ${formatLiteral(chip.value ?? '')}]`
  const op = chip.op
  if (!op) return `[if ${chip.refId}]`
  const token = OP_TOKENS[op]
  if (!opNeedsValue(op)) return `[if ${chip.refId} ${token}]`
  if (op === 'in') return `[if ${chip.refId} in ${(chip.values ?? []).map(formatLiteral).join(', ')}]`
  if (opNeedsUnit(op)) return `[if ${chip.refId} ${token} ${formatLiteral(chip.value ?? '')} ${chip.unit ?? ''}]`.replace(/\s+/g, ' ').trimEnd()
  return `[if ${chip.refId} ${token} ${formatLiteral(chip.value ?? '')}]`
}

// A target an approval option routes to, in the same spelling branch lines use.
const formatTarget = (target: string): string =>
  target === 'done' ? 'end' : target === 'handoff' ? 'handoff' : `step:${target}`

// One choice of a gate: `id="Label"`, an optional `("Description")`, and — for the block
// approval form — an optional `-> target`. Quotes and backslashes are escaped so authored
// labels/descriptions survive portable text copy/paste.
const formatOption = (option: ApprovalDocOption, includeTarget: boolean): string => {
  let token = `${option.id}="${escapeQuoted(option.label)}"`
  if (option.description) token += ` ("${escapeQuoted(option.description)}")`
  if (includeTarget && option.target) token += ` -> ${formatTarget(option.target)}`
  return token
}

const formatGateToken = (keyword: 'decision' | 'approval', chip: ChipTokenInput): string => {
  const captureKey = chip.captureKey ?? chip.refId
  const options = (chip.options ?? []).map((option) => formatOption(option, keyword === 'approval')).join(', ')
  return `[${keyword} ${captureKey}: ${options}]`
}

const formatActionToken = (refId: string): string =>
  BARE_ACTION_REF.test(refId) ? `[action ${refId}]` : `[action "${escapeQuoted(refId)}"]`

// One chip → its canonical inline token. Shared by the editor's copy path (live node) and
// document serialization (parsed segment).
export const tokenForChip = (chip: ChipTokenInput): string => {
  switch (chip.chipKind) {
    case 'variable':
      return `@${chip.refId}`
    case 'skill':
      return `@${chip.refId}${formatSkillSuffix(chip)}`
    case 'end':
      return '-> end'
    case 'handoff':
      return '-> handoff'
    case 'step':
      return `-> step:${chip.refId}${chip.counterLimit != null ? ` (max ${chip.counterLimit})` : ''}`
    case 'condition':
      return formatConditionToken(chip)
    case 'action':
      return formatActionToken(chip.refId)
    case 'decision':
      return formatGateToken('decision', chip)
    case 'approval':
      return formatGateToken('approval', chip)
    default:
      return ''
  }
}

const formatParagraph = (paragraph: ProseParagraph): string => {
  const body = paragraph.segments
    .map((segment) => (segment.kind === 'text' ? segment.text : tokenForChip(segment)))
    .join('')
  return paragraph.headingLevel === 1 ? `# ${body}` : body
}

const referencedVariableIds = (paragraphs: ProseParagraph[]): Set<string> => {
  // A gate's capture key isn't a variable, and neither is the branch condition that tests it
  // (its refId is the capture key) nor the outcome sentinel — exclude all of those.
  const captureKeys = new Set<string>()
  for (const paragraph of paragraphs) {
    for (const segment of paragraph.segments) {
      if (segment.kind === 'chip' && (segment.chipKind === 'decision' || segment.chipKind === 'approval')) {
        captureKeys.add(segment.captureKey ?? segment.refId)
      }
    }
  }
  const ids = new Set<string>()
  for (const paragraph of paragraphs) {
    for (const segment of paragraph.segments) {
      if (segment.kind !== 'chip') continue
      if (segment.chipKind === 'variable') ids.add(segment.refId)
      if (segment.chipKind === 'condition' && segment.refId !== OUTCOME_GUARD_REF && !captureKeys.has(segment.refId)) ids.add(segment.refId)
      if (segment.chipKind === 'skill') {
        for (const binding of Object.values(segment.inputBindings ?? {})) {
          if (binding.kind === 'variableRef') ids.add(binding.ref)
        }
        for (const ref of Object.values(segment.outputAssignments ?? {})) ids.add(ref)
      }
    }
  }
  return ids
}

export const serializeProseDoc = (input: {
  name: string
  trigger: string
  variables: ChipDocVariable[]
  paragraphs: ProseParagraph[]
}): string => {
  const referenced = referencedVariableIds(input.paragraphs)
  // A variable needs a declaration only when it carries something a bare `@name` can't —
  // a non-text type, or an optional/mutable flag. The common case (required, non-mutable,
  // text) round-trips as plain text, so the header stays uncluttered.
  const declaredVars = input.variables.filter((variable) =>
    referenced.has(variable.id)
    && (variable.type !== 'text' || variable.required === false || variable.mutable === true))

  const front = [FENCE, `name: ${input.name}`, `trigger: ${input.trigger}`]
  if (declaredVars.length > 0) {
    // Each declaration is `key:type` plus optional `:optional` / `:mutable` flag tokens.
    front.push(`vars: ${declaredVars.map((variable) => {
      const flags = [
        ...(variable.required === false ? ['optional'] : []),
        ...(variable.mutable === true ? ['mutable'] : []),
      ]
      return [variable.id, variable.type, ...flags].join(':')
    }).join(', ')}`)
  }
  front.push(FENCE)

  return [...front, ...input.paragraphs.map(formatParagraph)].join('\n')
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.-]*/

const coerceLiteral = (raw: string): RoutineFieldGuardValue => {
  const trimmed = raw.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed !== '' && !Number.isNaN(Number(trimmed))) return Number(trimmed)
  return trimmed
}

const parseBinding = (raw: string): RoutineInputBinding => {
  const trimmed = raw.trim()
  if (trimmed.startsWith('@')) return { kind: 'variableRef', ref: trimmed.slice(1) }
  return { kind: 'literal', value: coerceLiteral(trimmed) }
}

const splitList = (raw: string): string[] =>
  raw.split(',').map((part) => part.trim()).filter((part) => part !== '')

// Parse a `[if ref op value unit]` condition body (the text already stripped of brackets).
const parseConditionBody = (body: string): Extract<ProseSegment, { kind: 'chip' }> | null => {
  const idMatch = IDENTIFIER.exec(body.trim())
  if (!idMatch) return null
  const refId = idMatch[0]
  const rest = body.trim().slice(refId.length).trim()
  if (rest === '') {
    return { kind: 'chip', chipKind: 'condition', refId, label: refId }
  }
  const entry = OP_ENTRIES.find(([, token]) => rest === token || rest.startsWith(`${token} `))
  if (!entry) return null
  const [op, token] = entry
  const tail = rest.slice(token.length).trim()
  if (!opNeedsValue(op)) {
    return { kind: 'chip', chipKind: 'condition', refId, op, label: `${refId} ${token}` }
  }
  if (op === 'in') {
    return { kind: 'chip', chipKind: 'condition', refId, op, values: splitList(tail).map(coerceLiteral), label: `${refId} in ${tail}` }
  }
  if (opNeedsUnit(op)) {
    const parts = tail.split(/\s+/)
    const unit = parts.length > 1 && (GUARD_UNITS as readonly string[]).includes(parts[parts.length - 1]!)
      ? (parts.pop() as RoutineFieldGuardUnit)
      : null
    return { kind: 'chip', chipKind: 'condition', refId, op, value: coerceLiteral(parts.join(' ')), unit, label: `${refId} ${token} ${tail}` }
  }
  return { kind: 'chip', chipKind: 'condition', refId, op, value: coerceLiteral(tail), label: `${refId} ${token} ${tail}` }
}

// Map a target token (`end` / `handoff` / `step:<id>`) back to its stored ref.
const parseTarget = (token: string | undefined): string | undefined => {
  if (!token) return undefined
  if (token === 'end') return 'done'
  if (token === 'handoff') return 'handoff'
  return token.startsWith('step:') ? token.slice('step:'.length) : undefined
}

// Parse a gate's option list: `id="Label" ("Description") -> target, ...`. Description and
// target are optional; whitespace and the comma separators are tolerated.
const QUOTED_VALUE = '"((?:\\\\.|[^"\\\\])*)"'
const GATE_OPTION = new RegExp(`([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*${QUOTED_VALUE}(?:\\s*\\(${QUOTED_VALUE}\\))?(?:\\s*->\\s*(end|handoff|step:[A-Za-z_][A-Za-z0-9_.-]*))?`, 'g')
const parseGateOptions = (body: string): ApprovalDocOption[] => {
  const options: ApprovalDocOption[] = []
  for (const match of body.matchAll(GATE_OPTION)) {
    const target = parseTarget(match[4])
    options.push({
      id: match[1]!,
      label: unescapeQuoted(match[2] ?? ''),
      ...(match[3] ? { description: unescapeQuoted(match[3]) } : {}),
      ...(target ? { target } : {}),
    })
  }
  return options
}

const findBracketClose = (value: string): number => {
  let quoted = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quoted && char === '\\') {
      index += 1
      continue
    }
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && char === ']') return index
  }
  return -1
}

const parseActionBody = (body: string): string | null => {
  const trimmed = body.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return unescapeQuoted(trimmed.slice(1, -1))
  }
  const idMatch = IDENTIFIER.exec(trimmed)
  return idMatch && idMatch[0] === trimmed ? idMatch[0] : null
}

// Parse a `[decision key: ...]` / `[approval key: ...]` gate body (brackets already stripped).
const parseGateBody = (chipKind: 'decision' | 'approval', body: string): Extract<ProseSegment, { kind: 'chip' }> | null => {
  const colon = body.indexOf(':')
  if (colon === -1) return null
  const captureKey = body.slice(0, colon).trim()
  if (!captureKey) return null
  return {
    kind: 'chip',
    chipKind,
    refId: captureKey,
    captureKey,
    label: chipKind,
    options: parseGateOptions(body.slice(colon + 1)),
  }
}

const parseSkillSuffix = (suffix: string): Pick<Extract<ProseSegment, { kind: 'chip' }>, 'inputBindings' | 'outputAssignments' | 'mode'> => {
  const inputBindings: Record<string, RoutineInputBinding> = {}
  const outputAssignments: Record<string, string> = {}
  let mode: RoutineStepMode | undefined
  for (const section of suffix.split(';')) {
    const trimmed = section.trim()
    if (trimmed.startsWith('in ')) {
      for (const pair of splitList(trimmed.slice(3))) {
        const eq = pair.indexOf('=')
        if (eq > 0) inputBindings[pair.slice(0, eq).trim()] = parseBinding(pair.slice(eq + 1))
      }
    } else if (trimmed.startsWith('out ')) {
      for (const pair of splitList(trimmed.slice(4))) {
        const eq = pair.indexOf('=')
        if (eq > 0) outputAssignments[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim().replace(/^@/, '')
      }
    } else if (trimmed.startsWith('mode ')) {
      const value = trimmed.slice(5).trim()
      if (value === 'typed' || value === 'untyped') mode = value
    }
  }
  return { inputBindings, outputAssignments, mode }
}

// Parse one line's inline tokens into ordered segments. `resolveKind` decides whether a
// bare `@name` is a skill (in the agent's catalog) or a variable.
const parseSegments = (line: string, resolveKind: (name: string) => ProseChipKind): ProseSegment[] => {
  const segments: ProseSegment[] = []
  let buffer = ''
  let index = 0
  const flush = () => {
    if (buffer) segments.push({ kind: 'text', text: buffer })
    buffer = ''
  }
  while (index < line.length) {
    const rest = line.slice(index)

    if (rest.startsWith('-> end')) { flush(); segments.push({ kind: 'chip', chipKind: 'end', refId: 'done', label: 'end' }); index += '-> end'.length; continue }
    if (rest.startsWith('-> handoff')) { flush(); segments.push({ kind: 'chip', chipKind: 'handoff', refId: 'handoff', label: 'handoff' }); index += '-> handoff'.length; continue }

    const stepMatch = /^-> step:([A-Za-z_][A-Za-z0-9_.-]*)(?:\s*\(max (\d+)\))?/.exec(rest)
    if (stepMatch) {
      flush()
      segments.push({ kind: 'chip', chipKind: 'step', refId: stepMatch[1]!, label: stepMatch[1]!, counterLimit: stepMatch[2] ? Number(stepMatch[2]) : null })
      index += stepMatch[0].length
      continue
    }

    if (rest.startsWith('[if ')) {
      const close = findBracketClose(rest)
      if (close !== -1) {
        const condition = parseConditionBody(rest.slice('[if '.length, close))
        if (condition) { flush(); segments.push(condition); index += close + 1; continue }
      }
    }

    if (rest.startsWith('[outcome ')) {
      const close = findBracketClose(rest)
      if (close !== -1) {
        const status = rest.slice('[outcome '.length, close).trim()
        if (status) { flush(); segments.push({ kind: 'chip', chipKind: 'condition', refId: OUTCOME_GUARD_REF, value: status, label: `outcome is ${status}` }); index += close + 1; continue }
      }
    }

    if (rest.startsWith('[action ')) {
      const close = findBracketClose(rest)
      if (close !== -1) {
        const actionRef = parseActionBody(rest.slice('[action '.length, close))
        if (actionRef) { flush(); segments.push({ kind: 'chip', chipKind: 'action', refId: actionRef, label: actionRef }); index += close + 1; continue }
      }
    }

    if (rest.startsWith('[decision ') || rest.startsWith('[approval ')) {
      const close = findBracketClose(rest)
      if (close !== -1) {
        const chipKind = rest.startsWith('[decision ') ? 'decision' as const : 'approval' as const
        const gate = parseGateBody(chipKind, rest.slice(`[${chipKind} `.length, close))
        if (gate) { flush(); segments.push(gate); index += close + 1; continue }
      }
    }

    if (rest.startsWith('@')) {
      const idMatch = IDENTIFIER.exec(rest.slice(1))
      if (idMatch) {
        // Trailing sentence punctuation isn't part of the ref — leave it as text so
        // `record as @name.` keeps the period (mirrors the backend mention rule).
        const refId = idMatch[0].replace(/[.,;:!?]+$/, '')
        const consumed = 1 + refId.length
        if (refId === '') { buffer += line[index]; index += 1; continue }
        const kind = resolveKind(refId)
        if (kind === 'skill' && rest[consumed] === '[') {
          const close = rest.indexOf(']', consumed)
          if (close !== -1) {
            const bindings = parseSkillSuffix(rest.slice(consumed + 1, close))
            flush()
            segments.push({ kind: 'chip', chipKind: 'skill', refId, label: refId, ...bindings })
            index += close + 1
            continue
          }
        }
        flush()
        segments.push(kind === 'skill'
          ? { kind: 'chip', chipKind: 'skill', refId, label: refId }
          : { kind: 'chip', chipKind: 'variable', refId, label: `@${refId}` })
        index += consumed
        continue
      }
    }

    buffer += line[index]
    index += 1
  }
  flush()
  return segments.length > 0 ? segments : [{ kind: 'text', text: '' }]
}

// True when pasted text carries our frontmatter fence or any chip token — the signal that
// the editor should reconstruct a routine rather than insert the text literally.
export const looksLikeRoutineProse = (text: string): boolean => {
  const trimmed = text.trim()
  if (trimmed.startsWith(`${FENCE}\nname:`) || trimmed.startsWith(`${FENCE}\r\nname:`)) return true
  return /(^|\s)(-> (end|handoff|step:)|\[(if|outcome|action|decision|approval) )/.test(text) || /(^|\s)@[A-Za-z_]/.test(text)
}

export const parseProseDoc = (
  text: string,
  resolveSkill: (name: string) => boolean,
): ParsedProseDoc => {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let name: string | null = null
  let trigger: string | null = null
  let hadFrontmatter = false
  const declaredTypes = new Map<string, RoutineSlotType>()
  // Slot flags declared alongside the type (`key:type:optional:mutable`). Absent = default
  // (required, non-mutable), so we only record the non-default flags we actually saw.
  const declaredFlags = new Map<string, { required?: boolean; mutable?: boolean }>()

  let bodyStart = 0
  if (lines[0]?.trim() === FENCE) {
    let cursor = 1
    while (cursor < lines.length && lines[cursor]!.trim() !== FENCE) {
      const line = lines[cursor]!
      const sep = line.indexOf(':')
      if (sep !== -1) {
        const key = line.slice(0, sep).trim()
        const value = line.slice(sep + 1).trim()
        if (key === 'name') { name = value; hadFrontmatter = true }
        else if (key === 'trigger') { trigger = value; hadFrontmatter = true }
        else if (key === 'vars') {
          hadFrontmatter = true
          for (const declaration of splitList(value)) {
            const [varKey, varType, ...flags] = declaration.split(':').map((part) => part.trim())
            if (varKey && varType && (SLOT_TYPES as readonly string[]).includes(varType)) {
              declaredTypes.set(varKey, varType as RoutineSlotType)
              const required = flags.includes('optional') ? false : undefined
              const mutable = flags.includes('mutable') ? true : undefined
              if (required !== undefined || mutable !== undefined) {
                declaredFlags.set(varKey, {
                  ...(required !== undefined ? { required } : {}),
                  ...(mutable !== undefined ? { mutable } : {}),
                })
              }
            }
          }
        }
      }
      cursor += 1
    }
    bodyStart = cursor < lines.length ? cursor + 1 : cursor
  }

  const resolveKind = (refName: string): ProseChipKind => (resolveSkill(refName) ? 'skill' : 'variable')

  const paragraphs: ProseParagraph[] = []
  for (const raw of lines.slice(bodyStart)) {
    const isHeading = raw.startsWith('# ')
    const content = isHeading ? raw.slice(2) : raw
    paragraphs.push({
      ...(isHeading ? { headingLevel: 1 as const } : {}),
      segments: parseSegments(content, resolveKind),
    })
  }
  // A trailing blank line from the join shouldn't add an empty paragraph.
  while (paragraphs.length > 1) {
    const last = paragraphs[paragraphs.length - 1]!
    if (last.headingLevel || last.segments.some((segment) => segment.kind !== 'text' || segment.text !== '')) break
    paragraphs.pop()
  }

  // Variables = everything referenced, typed from the `vars:` declaration (default text).
  const referenced = referencedVariableIds(paragraphs)
  const variables: ChipDocVariable[] = [...referenced].map((id) => ({
    id,
    name: id,
    type: declaredTypes.get(id) ?? 'text',
    ...declaredFlags.get(id),
  }))

  return { name, trigger, variables, paragraphs, hadFrontmatter }
}
