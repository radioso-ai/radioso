'use client'

// Bridge between the portable prose grammar (`@radioso/routine-markdown`) and the live
// Lexical tree. Both directions preserve where each chip sits inside its line, which is what
// a sentence-shaped surface needs — the flat `{text, chips}` block encoder does not.

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  type LexicalNode,
} from 'lexical'

import { $createHeadingNode, $isHeadingNode } from '@lexical/rich-text'

import {
  $createAiConditionChipNode,
  $createApprovalChipNode,
  $createChipNode,
  $createConditionChipNode,
  $createDecisionChipNode,
  $createEndChipNode,
  $createOutcomeConditionChipNode,
  $createSlotFilledConditionChipNode,
  $createStepChipNode,
  $isChipNode,
} from '@/components/dashboard/settings/routine-chip-node'
import {
  OUTCOME_GUARD_REF,
  SLOT_FILLED_GUARD_REF,
  type ProseParagraph,
  type ProseSegment,
} from '@/lib/routine-prose'

// One prose paragraph → a Lexical block (a variable becomes a chip, condition/handoff/step
// chips carry their metadata, everything else is literal text). Shared by the initial load
// and a clipboard paste.
export function $proseParagraphToNode(paragraph: ProseParagraph): LexicalNode {
  const node = paragraph.headingLevel === 1 ? $createHeadingNode('h1') : $createParagraphNode()
  for (const segment of paragraph.segments) {
    if (segment.kind === 'text') {
      node.append($createTextNode(segment.text))
    } else if (segment.chipKind === 'condition' && segment.refId === OUTCOME_GUARD_REF) {
      // An outcome guard (branches on the preceding tool step's result): the status rides in
      // `value`. Recreated via its own node so the sentinel refId survives the round-trip.
      node.append($createOutcomeConditionChipNode(typeof segment.value === 'string' ? segment.value : segment.label))
    } else if (segment.chipKind === 'condition' && segment.refId === SLOT_FILLED_GUARD_REF) {
      // A slot-filled guard (continues once the named slots are present): the slot keys ride in
      // `values`. Recreated via its own node so the sentinel refId + slot set survive the round-trip.
      const keys = (segment.values ?? []).map((value) => String(value)).filter((key) => key.length > 0)
      node.append($createSlotFilledConditionChipNode(keys, segment.label))
    } else if (segment.chipKind === 'condition' && segment.op) {
      node.append($createConditionChipNode(segment.refId, segment.op, segment.label, segment.value ?? null, segment.values ?? null, segment.unit ?? null))
    } else if (segment.chipKind === 'condition') {
      // A decided-by-AI selector (no operator): a bare marker; the phrase rides in the adjacent
      // text segment, so the chip carries no payload.
      node.append($createAiConditionChipNode())
    } else if (segment.chipKind === 'step') {
      node.append($createStepChipNode(segment.refId, segment.label, segment.counterLimit ?? null))
    } else if (segment.chipKind === 'approval') {
      node.append($createApprovalChipNode(segment.captureKey ?? '', segment.options ?? []))
    } else if (segment.chipKind === 'decision') {
      node.append($createDecisionChipNode(segment.captureKey ?? '', segment.options ?? []))
    } else if (segment.chipKind === 'end') {
      // A named ending carries its own completion message in `value`; recreated via its own node
      // so the message survives the round-trip (the generic chip path drops it).
      node.append($createEndChipNode(segment.refId, typeof segment.value === 'string' ? segment.value : null, segment.label))
    } else {
      node.append($createChipNode(segment.chipKind, segment.refId, segment.label, {
        inputBindings: segment.inputBindings,
        outputAssignments: segment.outputAssignments,
        mode: segment.mode,
      }))
    }
  }
  return node
}

// Build the editor's initial document from loaded prose paragraphs.
export function $initializeFromParagraphs(paragraphs: ProseParagraph[]): void {
  const root = $getRoot()
  if (root.getChildrenSize() > 0) return
  for (const paragraph of paragraphs) root.append($proseParagraphToNode(paragraph))
}

// Read the live tree into ordered prose paragraphs (text + inline chips), preserving where
// each chip sits — the shape the token serializer turns into portable clipboard text.
export function $readProseParagraphs(): ProseParagraph[] {
  return $getRoot().getChildren().map((block) => {
    const segments: ProseSegment[] = []
    if ($isElementNode(block)) {
      for (const child of block.getChildren()) {
        if ($isChipNode(child)) {
          segments.push({
            kind: 'chip',
            chipKind: child.getChipKind(),
            refId: child.getRefId(),
            label: child.getRefId(),
            op: child.getChipOp() ?? undefined,
            value: child.getChipValue(),
            values: child.getChipValues(),
            unit: child.getChipUnit() ?? undefined,
            counterLimit: child.getChipCounterLimit(),
            inputBindings: child.getInputBindings(),
            outputAssignments: child.getOutputAssignments(),
            mode: child.getMode() ?? undefined,
            captureKey: child.getCaptureKey() ?? undefined,
            options: child.getApprovalOptions(),
          })
        } else {
          segments.push({ kind: 'text', text: child.getTextContent() })
        }
      }
    }
    return {
      ...($isHeadingNode(block) ? { headingLevel: 1 as const } : {}),
      segments,
    }
  })
}
