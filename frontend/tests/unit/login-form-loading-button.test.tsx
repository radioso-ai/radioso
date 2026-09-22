/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The submit button used to render `{isLoading ? <Spinner/> : null}` next to a bare "Sign In"
// text node. When the loading flag flipped, React committed the spinner with
// `insertBefore(spinner, textNode)`. If page translation, a browser extension, or a password
// manager had already swapped that text node, the reference node was no longer a child of the
// button and the DOM call threw `NotFoundError`, which the frontend error boundary turned into
// the generic failure screen — locking the user out of sign-in. Wrapping the label in a <span>
// gives React a stable element reference to insert against, so the swap no longer breaks it.

const apiMocks = vi.hoisted(() => ({
  getGoogleLoginStatus: vi.fn(),
  login: vi.fn(),
  getStoredActiveWorkspaceId: vi.fn(),
}))

const authContextMocks = vi.hoisted(() => ({
  useOptionalAuth: vi.fn(),
  getStoredLastAccountId: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    authApi: {
      ...actual.authApi,
      getGoogleLoginStatus: apiMocks.getGoogleLoginStatus,
      login: apiMocks.login,
    },
    getStoredActiveWorkspaceId: apiMocks.getStoredActiveWorkspaceId,
  }
})

vi.mock('@/lib/auth-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-context')>()
  return {
    ...actual,
    useOptionalAuth: authContextMocks.useOptionalAuth,
    getStoredLastAccountId: authContextMocks.getStoredLastAccountId,
  }
})

import { LoginForm } from '@/components/auth/login-form'

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

// Stand in for a page translator / extension / password manager: replace the first text node
// inside `el` with a fresh one, removing the original from the DOM the way those tools do.
function retranslateFirstTextNode(el: Element) {
  const textNode = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()
  expect(textNode).toBeTruthy()
  const replacement = document.createTextNode(`${textNode?.textContent ?? ''} (translated)`)
  textNode?.parentNode?.replaceChild(replacement, textNode)
}

describe('LoginForm submit button loading state', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    apiMocks.getGoogleLoginStatus.mockResolvedValue({ enabled: false })
    // A login that never settles keeps the button in its loading state so the spinner insert runs.
    apiMocks.login.mockReturnValue(new Promise(() => undefined))
    apiMocks.getStoredActiveWorkspaceId.mockReturnValue(null)
    authContextMocks.useOptionalAuth.mockReturnValue({ login: vi.fn() })
    authContextMocks.getStoredLastAccountId.mockReturnValue(undefined)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it('renders the spinner without crashing when the label node was replaced externally', async () => {
    await act(async () => {
      root.render(
        <LoginForm
          registrationAvailable={false}
          registrationAvailabilityFailed={false}
          onRetryRegistrationAvailability={() => undefined}
          onSwitchToRegister={() => undefined}
        />,
      )
    })

    const submitButton = [...container.querySelectorAll('button')]
      .find((button) => button.getAttribute('type') === 'submit')
    expect(submitButton).toBeTruthy()

    // Simulate the external mutation before the loading flag flips.
    retranslateFirstTextNode(submitButton!)

    const form = container.querySelector('form')
    expect(form).toBeTruthy()

    let threw: unknown = null
    await act(async () => {
      try {
        form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      } catch (error) {
        threw = error
      }
    })

    expect(threw).toBeNull()
    expect(apiMocks.login).toHaveBeenCalledOnce()
    // The spinner (an svg with role="status") committed next to the surviving label element.
    expect(submitButton!.querySelector('svg[role="status"]')).toBeTruthy()
  })
})
