import { afterEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.fn()

vi.mock('@/lib/api-client', () => ({
  request: requestMock,
}))

describe('workbench replay API', () => {
  afterEach(() => {
    requestMock.mockReset()
  })

  it('runs replay through the eval one-off endpoint with a top-level agentConfigOverride', async () => {
    requestMock.mockResolvedValueOnce({ run: { id: 'run-1' }, case: null, answer: 'Replay answer' })

    const { workbenchApi } = await import('@/lib/api-workbench')

    await workbenchApi.replay({
      snapshotId: '11111111-1111-4111-8111-111111111111',
      agentConfigOverride: {
        customInstruction: 'Use release notes.',
        chatModelOverride: { provider: 'openai', model: 'gpt-5.4' },
      },
    })

    expect(requestMock).toHaveBeenCalledWith(
      '/evals/runs',
      {
        method: 'POST',
        body: JSON.stringify({
          mode: 'full_assistant',
          snapshotId: '11111111-1111-4111-8111-111111111111',
          agentConfigOverride: {
            customInstruction: 'Use release notes.',
            chatModelOverride: { provider: 'openai', model: 'gpt-5.4' },
          },
        }),
      },
      { withApiToken: true },
    )
  })

  it('preserves normal eval one-off request shape when no agent config override is supplied', async () => {
    requestMock.mockResolvedValueOnce({ run: { id: 'run-2' }, case: null })

    const { evalsApi } = await import('@/lib/api-eval')

    await evalsApi.runOneOff({
      snapshotId: '22222222-2222-4222-8222-222222222222',
      overrides: {
        retrievalSettingsOverride: { vectorTopK: 5 },
      },
    })

    expect(requestMock).toHaveBeenCalledWith(
      '/evals/runs',
      {
        method: 'POST',
        body: JSON.stringify({
          mode: 'retrieval_only',
          snapshotId: '22222222-2222-4222-8222-222222222222',
          overrides: {
            retrievalSettingsOverride: { vectorTopK: 5 },
          },
        }),
      },
      { withApiToken: true },
    )
  })
})
