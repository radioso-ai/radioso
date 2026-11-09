import type { ParseDiagnostic } from './types.js'

// Constructors for the parse diagnostics a routine document can report, one per grammar rule.

export const grammarVersionDiagnostic = (version: number, line: number): ParseDiagnostic => ({
  line,
  code: 'unsupported_grammar_version',
  message: `Unsupported routine grammar version: ${version}`,
})

export const invalidReentryDiagnostic = (value: string, line: number): ParseDiagnostic => ({
  line,
  code: 'invalid_reentry',
  message: `Unsupported routine reentry mode: ${value}`,
})

export const invalidStartModeDiagnostic = (value: string, line: number): ParseDiagnostic => ({
  line,
  code: 'invalid_start_mode',
  message: `Unsupported routine start mode: ${value}`,
})

export const invalidPriorityDiagnostic = (value: string, line: number): ParseDiagnostic => ({
  line,
  code: 'invalid_priority',
  message: `Routine priority must be an integer: ${value}`,
})

export const unknownFrontmatterKeyDiagnostic = (key: string, line: number): ParseDiagnostic => ({
  line,
  code: 'unknown_frontmatter_key',
  message: `Unknown routine frontmatter key: ${key}`,
})

export const invalidExportDiagnostic = (line: number): ParseDiagnostic => ({
  line,
  code: 'invalid_export',
  message: 'Routine export must be "<triggerKinds> -> <destinationRef>" with trigger kinds complete and/or handoff',
})

export const invalidFrontmatterDiagnostic = (key: string, line: number): ParseDiagnostic => ({
  line,
  code: 'invalid_frontmatter',
  message: `Invalid ${key} frontmatter: expected "<id>" or "<id> (\\"message\\")"`,
})

export const invalidVarDeclarationDiagnostic = (declaration: string, reason: string, line: number): ParseDiagnostic => ({
  line,
  code: 'invalid_var_declaration',
  message: `Invalid vars declaration "${declaration}": ${reason}`,
})

export const duplicateVarDeclarationDiagnostic = (key: string, line: number): ParseDiagnostic => ({
  line,
  code: 'duplicate_var_declaration',
  message: `Duplicate vars declaration for "${key}"`,
})

export const unknownBracketTokenDiagnostic = (token: string, line: number): ParseDiagnostic => ({
  line,
  code: 'unknown_bracket_token',
  message: `Unknown routine bracket token: ${token}`,
})

export const invalidGuardTokenDiagnostic = (token: string, line: number): ParseDiagnostic => ({
  line,
  code: 'invalid_guard_token',
  message: `Invalid guard token: ${token}`,
})

export const invalidActionTokenDiagnostic = (token: string, line: number): ParseDiagnostic => ({
  line,
  code: 'invalid_action_token',
  message: `Invalid action token: ${token}`,
})

export const invalidGateTokenDiagnostic = (token: string, line: number): ParseDiagnostic => ({
  line,
  code: 'invalid_gate_token',
  message: `Invalid gate token: ${token}`,
})

export const invalidTargetTokenDiagnostic = (token: string, line: number): ParseDiagnostic => ({
  line,
  code: 'invalid_target_token',
  message: `Invalid target token: ${token}`,
})

export const invalidSkillBindingSuffixDiagnostic = (refId: string, suffix: string, line: number): ParseDiagnostic => ({
  line,
  code: 'invalid_skill_binding_suffix',
  message: `Invalid skill binding suffix for "#${refId}": [${suffix}]`,
})

export const conflictingGuardAndCounterDiagnostic = (target: string, limit: string, line: number): ParseDiagnostic => ({
  line,
  code: 'conflicting_guard_and_counter',
  message: `Branch line combines a guard token with a counter limit; use "-> step:${target} (max ${limit})" without another guard for a bounded loop`,
})
