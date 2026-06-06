import { evalsApi, type AgentConfigOverrideInput, type WorkbenchReplayRunResponse } from './api-eval'

export type WorkbenchOverride = AgentConfigOverrideInput

export interface WorkbenchReplayInput {
  snapshotId: string
  agentConfigOverride: WorkbenchOverride
}

export const workbenchApi = {
  async replay(input: WorkbenchReplayInput): Promise<WorkbenchReplayRunResponse> {
    return evalsApi.runOneOff({
      snapshotId: input.snapshotId,
      mode: 'full_assistant',
      agentConfigOverride: input.agentConfigOverride,
    })
  },
}
