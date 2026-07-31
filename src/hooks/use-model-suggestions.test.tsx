/** @vitest-environment jsdom */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const settingsState = {
  smartSuggestionsEnabled: true,
  onlySuggestCheaper: false,
  preferredBudgetModel: '',
  preferredPremiumModel: '',
}

vi.mock('./use-settings', () => ({
  useSettings: () => ({ settings: settingsState }),
}))

import { useModelSuggestions } from './use-model-suggestions'

function buildMessages(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'short message',
  }))
}

async function renderHook(props: Parameters<typeof useModelSuggestions>[0]) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let renderCount = 0
  let result: ReturnType<typeof useModelSuggestions> | undefined

  function HookHost({ hookProps }: { hookProps: typeof props }) {
    renderCount++
    result = useModelSuggestions(hookProps)
    return null
  }

  await React.act(async () => {
    root.render(<HookHost hookProps={props} />)
  })

  return {
    getRenderCount: () => renderCount,
    getResult: () => result,
    async rerender(nextProps: typeof props) {
      await React.act(async () => {
        root.render(<HookHost hookProps={nextProps} />)
      })
    },
    async unmount() {
      await React.act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

beforeEach(() => {
  window.localStorage.clear()
  settingsState.smartSuggestionsEnabled = true
  settingsState.onlySuggestCheaper = false
  settingsState.preferredBudgetModel = ''
  settingsState.preferredPremiumModel = ''
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useModelSuggestions (re-enabled)', () => {
  it('does not enter an infinite render loop when the caller passes a freshly-mapped messages array every render (the original bug)', async () => {
    // chat-screen.tsx's real call site does historyMessages.map(...) inline,
    // producing a brand-new array reference on every render even when the
    // underlying content is unchanged. This is exactly the shape that
    // caused "Maximum update depth exceeded" before the .length-based fix.
    const props = {
      currentModel: 'gpt-4o',
      sessionKey: 'session-1',
      messages: buildMessages(5).map((m) => ({ ...m })),
      availableModels: ['gpt-4o', 'gpt-4o-mini'],
    }
    const hook = await renderHook(props)
    // A second render with a NEW array of the same length/content should
    // not cause additional effect-driven re-renders beyond React's own
    // settling passes.
    await hook.rerender({
      ...props,
      messages: buildMessages(5).map((m) => ({ ...m })),
    })
    expect(hook.getRenderCount()).toBeLessThan(10)
    await hook.unmount()
  })

  it('suggests a cheaper model for a simple task on a balanced-tier model', async () => {
    const hook = await renderHook({
      currentModel: 'gpt-4o',
      sessionKey: 'session-2',
      messages: buildMessages(4),
      availableModels: ['gpt-4o', 'gpt-4o-mini'],
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(hook.getResult()?.suggestion).toMatchObject({
      currentModel: 'gpt-4o',
      suggestedModel: 'gpt-4o-mini',
    })
    await hook.unmount()
  })

  it('returns no suggestion when the feature is disabled in settings', async () => {
    settingsState.smartSuggestionsEnabled = false
    const hook = await renderHook({
      currentModel: 'gpt-4o',
      sessionKey: 'session-3',
      messages: buildMessages(4),
      availableModels: ['gpt-4o', 'gpt-4o-mini'],
    })
    expect(hook.getResult()?.suggestion).toBeNull()
    await hook.unmount()
  })

  it('dismissForSession suppresses future suggestions for that session', async () => {
    const props = {
      currentModel: 'gpt-4o',
      sessionKey: 'session-4',
      messages: buildMessages(4),
      availableModels: ['gpt-4o', 'gpt-4o-mini'],
    }
    const hook = await renderHook(props)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(hook.getResult()?.suggestion).not.toBeNull()

    await React.act(async () => {
      hook.getResult()?.dismissForSession()
    })

    const stored = window.localStorage.getItem('modelSuggestionSessionDismissals')
    expect(stored).toContain('session-4')
    await hook.unmount()
  })
})
