import { execFileSync, spawn } from 'node:child_process'
import { resolve } from 'node:path'

const triple = execFileSync('rustc', ['--print', 'host-tuple'], {
  encoding: 'utf8',
}).trim()
const extension = triple.includes('windows') ? '.exe' : ''
const executable = resolve(
  'src-tauri',
  'binaries',
  `valkhana-web-${triple}${extension}`,
)
const port = 43847
const token = 'valkhana-sidecar-verification-token'
const origin = `http://127.0.0.1:${port}`
const child = spawn(executable, ['--port', String(port)], {
  env: { ...process.env, VALKHANA_DESKTOP_TOKEN: token },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stderr = ''
child.stderr.on('data', (chunk) => {
  stderr += chunk
})

async function waitForReady() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${origin}/__valkhana_desktop_ready`, {
        headers: { 'X-ValKhana-Desktop-Token': token },
      })
      if (response.ok && (await response.text()) === token) return
    } catch {
      // The process may still be starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`sidecar did not become ready: ${stderr}`)
}

try {
  await waitForReady()

  const unauthorized = await fetch(`${origin}/`)
  if (unauthorized.status !== 403) {
    throw new Error(`unauthorized root returned ${unauthorized.status}, expected 403`)
  }

  const root = await fetch(`${origin}/?desktop=1&token=${token}`, {
    redirect: 'manual',
  })
  const cookie = root.headers.get('set-cookie')?.split(';', 1)[0]
  const html = await root.text()
  if (!root.ok || !cookie || !html.startsWith('<!DOCTYPE html>')) {
    throw new Error('authenticated root did not return HTML and a session cookie')
  }

  const asset = await fetch(`${origin}/favicon.svg`, {
    headers: { Cookie: cookie },
  })
  if (!asset.ok) {
    throw new Error(`authenticated asset returned ${asset.status}`)
  }

  console.log('Tauri SSR sidecar verification passed')
} finally {
  child.kill()
  await new Promise((resolveExit) => child.once('exit', resolveExit))
}
