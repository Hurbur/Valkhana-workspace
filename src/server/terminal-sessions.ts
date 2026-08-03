/**
 * Terminal sessions using Python PTY helper.
 * Gives us real PTY (echo, colors, resize) without node-pty native addon.
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import EventEmitter from 'node:events'
import type { ChildProcess } from 'node:child_process'

export type TerminalSessionEvent = {
  event: string
  payload: unknown
}

export type TerminalSession = {
  id: string
  createdAt: number
  emitter: EventEmitter
  sendInput: (data: string) => void
  resize: (cols: number, rows: number) => void
  close: () => void
  /**
   * Mark that all live SSE listeners have detached. Starts an idle timer that
   * will reap the PTY if no listener reattaches in time. Lets the session
   * survive transient disconnects (network blips, browser tab suspension,
   * HMR reload) without killing the user's shell. See #298.
   */
  markDetached: () => void
  /** Cancel a pending detached-reap timer (called when a new listener attaches). */
  markAttached: () => void
}

// How long an unattached PTY session stays alive before it's reaped, in ms.
// Long enough to absorb tab suspension and short network blips, short enough
// that abandoned tabs don't pile up forever. Override with HERMES_TERMINAL_DETACH_TTL_MS.
const DETACH_TTL_MS = (() => {
  const raw = process.env.HERMES_TERMINAL_DETACH_TTL_MS
  const parsed = raw ? Number(raw) : NaN
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
  return 5 * 60_000 // 5 minutes
})()

const sessions = new Map<string, TerminalSession>()

// Resolve path to pty-helper.py relative to this file
const __dirname_resolved =
  typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url))
const PTY_HELPER = resolve(__dirname_resolved, 'pty-helper.py')

export function createTerminalSession(params: {
  command?: Array<string>
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
}): TerminalSession {
  const emitter = new EventEmitter()
  const sessionId = randomUUID()

  const home = process.env.HOME || homedir() || '/tmp'
  const defaultShell =
    process.platform === 'win32'
      ? 'powershell.exe'
      : process.platform === 'darwin'
        ? '/bin/zsh'
        : '/bin/bash'
  const command = params.command?.length
    ? params.command
    : [process.env.SHELL ?? defaultShell]
  let cwd = params.cwd ?? home
  if (cwd.startsWith('~')) {
    cwd = cwd.replace('~', home)
  }
  if (!existsSync(cwd)) {
    cwd = home
  }

  const cols = params.cols ?? 80
  const rows = params.rows ?? 24

  // Real scrollback replay, not just an early-buffer-until-first-listener.
  // Previously this only buffered output emitted before the FIRST listener
  // ever attached, then permanently stopped buffering -- so any listener
  // reconnecting later (page reload, network drop, tab stall bringing the
  // client back) got nothing of what was already on screen, only whatever
  // new data happened to stream in after they reconnected. If the session
  // was just idle at that moment, the client legitimately, correctly
  // rendered blank -- not a rendering bug, a real gap in data replay.
  //
  // Keep a rolling buffer of the actual PTY output text (not discrete
  // events -- concatenated text replays correctly regardless of how the
  // original chunks were split) and replay it to ANY newly attaching
  // listener, first or not.
  const SCROLLBACK_MAX_CHARS = 200_000
  let scrollback = ''
  let hasListeners = false

  emitter.on('newListener', (eventName, listener) => {
    if (eventName !== 'event') return
    hasListeners = true
    if (scrollback) {
      const replay = scrollback
      // Call the newly-attaching listener directly, NOT emitter.emit() --
      // emit() broadcasts to every listener already attached to 'event',
      // so if two tabs are already watching this session (a real case --
      // Swarm2 can open multiple simultaneous panes on the same session),
      // emit() would replay the scrollback into their terminals too and
      // duplicate output that was already correctly on screen. The
      // 'newListener' event hands us the exact listener function about to
      // be registered, so call it directly to target only that one.
      process.nextTick(() => {
        ;(listener as (evt: TerminalSessionEvent) => void)({
          event: 'data',
          payload: { data: replay },
        })
      })
    }
  })

  const pushEvent = (evt: TerminalSessionEvent) => {
    if (evt.event === 'data') {
      const payload = evt.payload as { data?: unknown }
      if (typeof payload?.data === 'string') {
        scrollback += payload.data
        if (scrollback.length > SCROLLBACK_MAX_CHARS) {
          scrollback = scrollback.slice(-SCROLLBACK_MAX_CHARS)
        }
      }
    }
    if (hasListeners) {
      emitter.emit('event', evt)
    }
  }

  // Spawn shell directly on Windows, else use Python PTY helper for POSIX
  let proc: ChildProcess
  if (process.platform === 'win32') {
    proc = spawn(command[0], command.slice(1), {
      cwd,
      env: {
        ...process.env,
        ...params.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        COLUMNS: String(cols),
        LINES: String(rows),
      } as Record<string, string>,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } else {
    proc = spawn(
      'python3',
      [PTY_HELPER, cwd, String(cols), String(rows), '--', ...command],
      {
        env: {
          ...process.env,
          ...params.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          COLUMNS: String(cols),
          LINES: String(rows),
        } as Record<string, string>,
        // 4th pipe (fd 3 in the child) is a dedicated out-of-band resize
        // control channel -- see resize() below and pty-helper.py.
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      },
    )
  }

  proc.stdout?.on('data', (data: Buffer) => {
    pushEvent({
      event: 'data',
      payload: { data: data.toString() },
    })
  })

  // stderr from the helper itself (not the shell)
  proc.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString()
    if (msg.trim()) {
      if (import.meta.env.DEV) console.error('[pty-helper stderr]', msg)
    }
  })

  proc.on('exit', (exitCode, signal) => {
    pushEvent({
      event: 'exit',
      payload: { exitCode, signal: signal ?? undefined },
    })
    emitter.emit('close')
    sessions.delete(sessionId)
  })

  proc.on('error', (err) => {
    pushEvent({
      event: 'error',
      payload: { message: err.message },
    })
  })

  let detachTimer: ReturnType<typeof setTimeout> | null = null

  const session: TerminalSession = {
    id: sessionId,
    createdAt: Date.now(),
    emitter,

    sendInput(data: string) {
      if (proc.stdin?.writable) {
        proc.stdin.write(data)
      }
    },

    resize(newCols: number, newRows: number) {
      // Write the new size to the dedicated control pipe (fd 3) so
      // pty-helper.py can actually apply it via TIOCSWINSZ. A bare
      // SIGWINCH alone did nothing useful here: a running child
      // process's environment can't be updated from the parent after
      // spawn, so the helper had no way to learn the real new size and
      // was just re-applying whatever size it was spawned with.
      const controlPipe = proc.stdio?.[3]
      if (
        controlPipe &&
        'writable' in controlPipe &&
        controlPipe.writable
      ) {
        try {
          controlPipe.write(String(newCols) + ' ' + String(newRows) + '\n')
        } catch {
          /* */
        }
      }
    },

    markDetached() {
      if (detachTimer) clearTimeout(detachTimer)
      detachTimer = setTimeout(() => {
        detachTimer = null
        // Only reap if the session is still in the map and the proc is alive.
        if (sessions.get(sessionId) === session) {
          session.close()
        }
      }, DETACH_TTL_MS)
    },

    markAttached() {
      if (detachTimer) {
        clearTimeout(detachTimer)
        detachTimer = null
      }
    },

    close() {
      if (detachTimer) {
        clearTimeout(detachTimer)
        detachTimer = null
      }
      try {
        proc.kill('SIGTERM')
        setTimeout(() => {
          try {
            proc.kill('SIGKILL')
          } catch {
            /* */
          }
        }, 2000)
      } catch {
        /* */
      }
      sessions.delete(sessionId)
    },
  }

  sessions.set(sessionId, session)
  return session
}

export function getTerminalSession(id: string): TerminalSession | null {
  return sessions.get(id) ?? null
}

export function closeTerminalSession(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  session.close()
}
