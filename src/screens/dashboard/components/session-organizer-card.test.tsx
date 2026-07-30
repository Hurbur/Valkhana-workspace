/** @vitest-environment jsdom */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionOrganizerCard } from './session-organizer-card'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

async function renderCard() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await React.act(async () => {
    root.render(<SessionOrganizerCard />)
  })
  return {
    container,
    async unmount() {
      await React.act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SessionOrganizerCard', () => {
  it('renders returned sessions and their project label', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        profile: { id: 'test2', name: 'test2' },
        sessions: [
          {
            id: 'one',
            title: 'Architecture review',
            source: 'cli',
            lastActive: 200,
            messageCount: 4,
            metadata: {
              pinned: false,
              archived: false,
              project: 'Valkhana',
              tags: [],
              updatedAt: null,
            },
          },
        ],
        total: 1,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = await renderCard()
    await React.act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Architecture review')
    expect(container.textContent).toContain('Valkhana')
    await unmount()
  })

  it('sends only sessionId and pinned on a pin toggle, never message content', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          profile: { id: 'test2', name: 'test2' },
          sessions: [
            {
              id: 'one',
              title: 'Architecture review',
              source: 'cli',
              lastActive: 200,
              messageCount: 4,
              metadata: {
                pinned: false,
                archived: false,
                project: null,
                tags: [],
                updatedAt: null,
              },
            },
          ],
          total: 1,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        Response.json({
          profile: { id: 'test2', name: 'test2' },
          sessions: [],
          total: 0,
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = await renderCard()
    await React.act(async () => {
      await Promise.resolve()
    })

    const pinButton = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.getAttribute('aria-label') === 'Pin',
    )
    expect(pinButton).toBeTruthy()

    await React.act(async () => {
      pinButton?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
      await Promise.resolve()
    })

    const patchCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
    )
    expect(patchCall).toBeTruthy()
    const body = JSON.parse((patchCall?.[1] as RequestInit).body as string)
    expect(body).toEqual({ sessionId: 'one', pinned: true })

    await unmount()
  })
})
