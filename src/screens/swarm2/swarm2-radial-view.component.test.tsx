/** @vitest-environment jsdom */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrewMember } from '@/hooks/use-crew-status'
import { Swarm2RadialView } from './swarm2-radial-view'
import { Swarm2Wires } from './swarm2-wires'

const member: CrewMember = {
  id: 'builder', displayName: 'Builder', role: 'Builder', specialty: 'UI work', mission: 'Ship the interface',
  profileFound: true, gatewayState: 'running', processAlive: true, platforms: {}, model: 'gpt-5.6-terra', provider: 'openai',
  lastSessionTitle: null, lastSessionAt: null, sessionCount: 0, messageCount: 0, toolCallCount: 0, totalTokens: 0,
  estimatedCostUsd: null, cronJobCount: 0, assignedTaskCount: 0,
}

const reactActGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean
}
reactActGlobal.IS_REACT_ACT_ENVIRONMENT = true

let originalResizeObserver: typeof ResizeObserver | undefined

beforeEach(() => {
  originalResizeObserver = globalThis.ResizeObserver
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver
})

afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver as typeof ResizeObserver
  vi.restoreAllMocks()
})

function rect(left: number, top: number, width = 100, height = 40): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect
}

async function renderInto(element: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await React.act(async () => { root.render(element) })
  return {
    container,
    rerender: async (next: React.ReactElement) => {
      await React.act(async () => { root.render(next) })
    },
    unmount: async () => {
      await React.act(async () => { root.unmount() })
      container.remove()
    },
  }
}

describe('Swarm2 radial view DOM', () => {
  it('wires the real hub ref and reveals selected worker details', async () => {
    const onHubRef = vi.fn()
    const { container, unmount } = await renderInto(
      <Swarm2RadialView
        members={[member]}
        runtimeByWorker={new Map([['builder', { currentTask: 'Review the patch', state: 'reviewing' }]])}
        roomIds={[]}
        selectedId="builder"
        onSelect={vi.fn()}
        onToggleRoom={vi.fn()}
        onOpenTui={vi.fn()}
        onOpenTasks={vi.fn()}
        onWorkerRef={() => vi.fn()}
        onHubRef={onHubRef}
      />,
    )

    const hub = container.querySelector('[aria-label="Orchestrator hub"]')
    expect(hub).not.toBeNull()
    expect(onHubRef).toHaveBeenCalledWith(hub)
    expect(container.querySelector('[role="region"][aria-label="Details for Builder"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Select Builder, Reviewing"]')).not.toBeNull()
    await unmount()
  })

  it('uses the non-absolute grid fallback in a narrow container', async () => {
    const previous = globalThis.ResizeObserver
    class NarrowResizeObserver {
      callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
      }
      observe() {
        this.callback([{ contentRect: { width: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver)
      }
      disconnect() {}
      unobserve() {}
    }
    globalThis.ResizeObserver = NarrowResizeObserver as unknown as typeof ResizeObserver

    try {
      const { container, unmount } = await renderInto(
        <Swarm2RadialView
          members={[member, { ...member, id: 'reviewer', displayName: 'Reviewer' }]}
          runtimeByWorker={new Map()}
          roomIds={[]}
          selectedId={null}
          onSelect={vi.fn()}
          onToggleRoom={vi.fn()}
          onOpenTui={vi.fn()}
          onOpenTasks={vi.fn()}
          onWorkerRef={() => vi.fn()}
          onHubRef={vi.fn()}
        />,
      )
      const node = container.querySelector('[data-swarm2-worker-id="builder"]')
      expect(node?.className).toContain('relative')
      expect(node?.className).not.toContain('absolute')
      await unmount()
    } finally {
      globalThis.ResizeObserver = previous
    }
  })

  it('remeasures wires when the ref version changes without changing worker count', async () => {
    const container = document.createElement('div')
    const anchor = document.createElement('div')
    const worker = document.createElement('div')
    let anchorX = 100
    vi.spyOn(container, 'getBoundingClientRect').mockImplementation(() => rect(0, 0, 500, 500))
    vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(() => rect(anchorX, 100))
    vi.spyOn(worker, 'getBoundingClientRect').mockImplementation(() => rect(300, 300))
    const frames: Array<FrameRequestCallback> = []
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    const flushFrames = () => {
      while (frames.length) frames.shift()?.(0)
    }

    try {
      const { container: rendered, rerender, unmount } = await renderInto(
        <Swarm2Wires containerRef={{ current: container }} anchorRef={{ current: anchor }} workerRefs={new Map([['builder', worker]])} workers={[{ id: 'builder', selected: false, inRoom: false }]} version={1} />,
      )
      await React.act(async () => { flushFrames(); await Promise.resolve() })
      const initialRequests = raf.mock.calls.length
      expect(rendered.querySelector('path')?.getAttribute('d')).not.toBeNull()
      anchorX = 200
      await rerender(
        <Swarm2Wires containerRef={{ current: container }} anchorRef={{ current: anchor }} workerRefs={new Map([['builder', worker]])} workers={[{ id: 'builder', selected: false, inRoom: false }]} version={2} />,
      )
      expect(raf.mock.calls.length).toBeGreaterThan(initialRequests)
      await React.act(async () => { flushFrames(); await Promise.resolve() })
      await unmount()
    } finally {
      frames.splice(0)
    }
  })
})
