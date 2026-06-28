import {
  evalsApi,
  type AgentConfigOverrideInput,
  type EvalRunRoutineStartStateInput,
  type WorkbenchReplayRunResponse,
} from './api-eval'

export type WorkbenchOverride = AgentConfigOverrideInput

export interface WorkbenchReplayInput {
  snapshotId: string
  agentConfigOverride: WorkbenchOverride
  // Optional mid-routine starting position. Sent via `overrides` (the routine start
  // state lives there), alongside the top-level agentConfigOverride.
  routineStartState?: EvalRunRoutineStartStateInput
}

export const workbenchApi = {
  async replay(input: WorkbenchReplayInput): Promise<WorkbenchReplayRunResponse> {
    return evalsApi.runOneOff({
      snapshotId: input.snapshotId,
      mode: 'full_assistant',
      agentConfigOverride: input.agentConfigOverride,
      ...(input.routineStartState
        ? { overrides: { routineStartState: input.routineStartState } }
        : {}),
    })
  },
}
