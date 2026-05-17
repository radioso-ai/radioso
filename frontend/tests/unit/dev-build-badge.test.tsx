import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { DevBuildBadge, resolveDevBuildInfo, resolveDevBuildLabel } from '@/components/dev-build-badge'

describe('resolveDevBuildLabel', () => {
  it('shows the dev build label only in development', () => {
    expect(resolveDevBuildLabel('development', 'dev la-paz branch abc123 mabc123')).toBe('dev la-paz branch abc123 mabc123')
    expect(resolveDevBuildLabel('production', 'dev la-paz branch abc123 mabc123')).toBeNull()
    expect(resolveDevBuildLabel('test', 'dev la-paz branch abc123 mabc123')).toBeNull()
    expect(resolveDevBuildLabel('development', '')).toBeNull()
  })

  it('falls back to the build id when a full label is unavailable', () => {
    expect(resolveDevBuildLabel('development', '', 'mabc123')).toBe('dev mabc123')
  })
})

describe('resolveDevBuildInfo', () => {
  it('returns structured dev build details in development', () => {
    expect(resolveDevBuildInfo(
      'development',
      'dev la-paz branch abc123 mabc123',
      'la-paz',
      'branch',
      'abc123',
      'mabc123',
    )).toEqual({
      branch: 'branch',
      buildId: 'mabc123',
      commit: 'abc123',
      label: 'dev la-paz branch abc123 mabc123',
      worktree: 'la-paz',
    })
  })
})

describe('DevBuildBadge', () => {
  it('does not render outside development', () => {
    expect(renderToStaticMarkup(<DevBuildBadge />)).toBe('')
  })
})
