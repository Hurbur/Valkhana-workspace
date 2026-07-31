/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedSessionsStore } from './use-pinned-sessions'

beforeEach(() => {
  usePinnedSessionsStore.setState({ pinnedSessionKeys: [] })
  window.localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('usePinnedSessionsStore server sync', () => {
  it('pinning a session updates local state immediately and syncs to the Session Organizer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    usePinnedSessionsStore.getState().pinSession('one')

    expect(usePinnedSessionsStore.getState().pinnedSessionKeys).toEqual(['one'])
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/dashboard/sessions',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ sessionId: 'one', pinned: true }),
      }),
    )
  })

  it('unpinning syncs pinned:false', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    usePinnedSessionsStore.getState().pinSession('one')
    fetchMock.mockClear()
    usePinnedSessionsStore.getState().unpinSession('one')

    expect(usePinnedSessionsStore.getState().pinnedSessionKeys).toEqual([])
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/dashboard/sessions',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ sessionId: 'one', pinned: false }),
      }),
    )
  })

  it('local pin state is unaffected when the server sync fails (fire-and-forget)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    vi.stubGlobal('fetch', fetchMock)

    usePinnedSessionsStore.getState().pinSession('one')

    expect(usePinnedSessionsStore.getState().pinnedSessionKeys).toEqual(['one'])
    // Let the rejected promise's .catch() settle before the test ends.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(usePinnedSessionsStore.getState().pinnedSessionKeys).toEqual(['one'])
  })

  it('toggling a pinned session unpins it and syncs pinned:false exactly once', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    usePinnedSessionsStore.setState({ pinnedSessionKeys: ['one'] })
    fetchMock.mockClear()
    usePinnedSessionsStore.getState().togglePinnedSession('one')

    expect(usePinnedSessionsStore.getState().pinnedSessionKeys).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/dashboard/sessions',
      expect.objectContaining({
        body: JSON.stringify({ sessionId: 'one', pinned: false }),
      }),
    )
  })

  it('pinning an already-pinned session is a no-op (no duplicate sync)', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    usePinnedSessionsStore.setState({ pinnedSessionKeys: ['one'] })
    usePinnedSessionsStore.getState().pinSession('one')

    expect(usePinnedSessionsStore.getState().pinnedSessionKeys).toEqual(['one'])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
