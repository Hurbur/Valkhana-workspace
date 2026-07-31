/** @vitest-environment jsdom */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HandoffStatusCard, terminalActionFor } from './handoff-status-card'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

describe('terminal handoff actions', () => {
  it('offers only the safe pickup action for a Brain-ready handoff', () => {
    expect(terminalActionFor('ready-for-terminal')).toEqual({
      label: 'Start terminal work',
      state: 'terminal-working',
    })
  })

  it('does not offer a terminal action while the Brain owns the handoff', () => {
    expect(terminalActionFor('brain-working')).toBeNull()
  })
})

async function renderCard() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await React.act(async () => { root.render(<HandoffStatusCard />) })
  return {
    container,
    async unmount() {
      await React.act(async () => { root.unmount() })
      container.remove()
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('HandoffStatusCard network behavior', () => {
  it('polls status and sends only the vetted terminal state when the pickup action is clicked', async () => {
    vi.useFakeTimers()
    const status = {
      version: 1,
      profileId: 'test2',
      updatedAt: '2026-07-30T10:00:00.000Z',
      actor: 'brain',
      state: 'ready-for-terminal',
      nextAction: 'Implement the route',
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ status, stale: false }))
      .mockResolvedValueOnce(Response.json({ status, stale: false }))
      .mockResolvedValueOnce(Response.json({
        status: { ...status, actor: 'terminal', state: 'terminal-working' },
        stale: false,
      }))
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = await renderCard()
    await React.act(async () => { await Promise.resolve() })
    expect(container.textContent).toContain('ready for terminal')

    await React.act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const button = Array.from(container.querySelectorAll('button')).find(
      (element) => element.textContent === 'Start terminal work',
    )
    expect(button).toBeDefined()
    await React.act(async () => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve() })

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/dashboard/handoff-status',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ state: 'terminal-working' }),
      }),
    )
    expect(container.textContent).toContain('terminal working')
    await unmount()
  })
})
