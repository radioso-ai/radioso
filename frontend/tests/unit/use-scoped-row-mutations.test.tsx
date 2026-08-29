/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  useScopedRowMutations,
  type ScopedRowMutations,
} from '@/components/dashboard/settings/use-scoped-row-mutations'

// A row control is a per-row mutation, not a section save: these are the four behaviours the
// single-flight save protocol got wrong when it was borrowed for one.
describe('useScopedRowMutations', () => {
  let container: HTMLDivElement
  let root: Root
  let latest: ScopedRowMutations

  beforeAll(() => {
    // React 19 reads this to decide whether act() may drive updates.
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  const Harness = ({ scopeKey }: { scopeKey: string }) => {
    latest = useScopedRowMutations(scopeKey)
    return null
  }

  const render = (scopeKey: string) => {
    act(() => root.render(<Harness scopeKey={scopeKey} />))
  }

  const deferred = <T,>() => {
    let resolve: (value: T) => void = () => {}
    let reject: (reason: unknown) => void = () => {}
    const promise = new Promise<T>((resolveFn, rejectFn) => {
      resolve = resolveFn
      reject = rejectFn
    })
    return { promise, resolve, reject }
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('holds only the row it was asked about, and releases it when that row settles', async () => {
    render('agent-1')
    const first = deferred<string>()

    let outcome: unknown
    act(() => {
      void latest.run('row-1', () => first.promise).then((value) => {
        outcome = value
      })
    })

    expect(latest.isPending('row-1')).toBe(true)
    expect(latest.isPending('row-2')).toBe(false)

    await act(async () => {
      first.resolve('saved')
      await first.promise
    })

    expect(outcome).toEqual({ status: 'applied', value: 'saved' })
    expect(latest.isPending('row-1')).toBe(false)
  })

  it('applies a committed row even when another row was mutated while it was in flight', async () => {
    // The case a single-flight protocol gets wrong: the second mutation does not make the first
    // one's result untrue, so discarding it would leave a row showing the opposite of what the
    // server stored until a reload.
    render('agent-1')
    const slow = deferred<string>()
    const quick = deferred<string>()

    let slowOutcome: unknown
    let quickOutcome: unknown
    act(() => {
      void latest.run('row-1', () => slow.promise).then((value) => {
        slowOutcome = value
      })
      void latest.run('row-2', () => quick.promise).then((value) => {
        quickOutcome = value
      })
    })

    expect(latest.isPending('row-1')).toBe(true)
    expect(latest.isPending('row-2')).toBe(true)

    await act(async () => {
      quick.resolve('second')
      await quick.promise
    })
    expect(quickOutcome).toEqual({ status: 'applied', value: 'second' })
    // The first row is still outstanding, so it stays held while the second is released.
    expect(latest.isPending('row-1')).toBe(true)
    expect(latest.isPending('row-2')).toBe(false)

    await act(async () => {
      slow.resolve('first')
      await slow.promise
    })
    expect(slowOutcome).toEqual({ status: 'applied', value: 'first' })
    expect(latest.isPending('row-1')).toBe(false)
  })

  it('reports a response that arrives after a scope change as stale', async () => {
    render('agent-1')
    const inFlight = deferred<string>()

    let outcome: unknown
    act(() => {
      void latest.run('row-1', () => inFlight.promise).then((value) => {
        outcome = value
      })
    })

    render('agent-2')

    await act(async () => {
      inFlight.resolve('belongs to agent-1')
      await inFlight.promise
    })

    expect(outcome).toEqual({ status: 'stale' })
  })

  it('releases every held row when the scope changes, so no control is stranded', async () => {
    render('agent-1')
    const neverSettles = deferred<string>()

    act(() => {
      void latest.run('row-1', () => neverSettles.promise)
    })
    expect(latest.isPending('row-1')).toBe(true)

    render('agent-2')

    // The lock belonged to the list that is no longer on screen, and it is gone without waiting
    // for a request that may never settle at all.
    expect(latest.isPending('row-1')).toBe(false)
  })

  it('returns the failure to the caller and still releases the row', async () => {
    render('agent-1')
    const failing = deferred<string>()
    const cause = new Error('save refused')

    let outcome: unknown
    act(() => {
      void latest.run('row-1', () => failing.promise).then((value) => {
        outcome = value
      })
    })

    await act(async () => {
      failing.reject(cause)
      await failing.promise.catch(() => undefined)
    })

    expect(outcome).toEqual({ status: 'failed', error: cause })
    expect(latest.isPending('row-1')).toBe(false)
  })
})
