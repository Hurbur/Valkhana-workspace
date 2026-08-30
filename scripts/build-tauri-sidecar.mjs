import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const triple = execFileSync('rustc', ['--print', 'host-tuple'], {
  encoding: 'utf8',
}).trim()
const extension = triple.includes('windows') ? '.exe' : ''
const baseOutput = resolve('src-tauri', 'binaries', `valkhana-web${extension}`)
const sidecarOutput = resolve(
  'src-tauri',
  'binaries',
  `valkhana-web-${triple}${extension}`,
)

mkdirSync(dirname(sidecarOutput), { recursive: true })
execFileSync(
  resolve('node_modules', '.bin', process.platform === 'win32' ? 'pkg.cmd' : 'pkg'),
  [
    'electron/prod-server.cjs',
    '--target',
    'host',
    '--compress',
    'GZip',
    '--output',
    baseOutput,
  ],
  { stdio: 'inherit' },
)
renameSync(baseOutput, sidecarOutput)
if (process.platform !== 'win32') chmodSync(sidecarOutput, 0o755)

console.log(`Prepared Tauri SSR sidecar: ${sidecarOutput}`)
