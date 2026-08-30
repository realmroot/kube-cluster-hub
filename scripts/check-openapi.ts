import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../control-plane/config'
import { hubOpenApi } from '../control-plane/contracts'

const directory = await mkdtemp(join(tmpdir(), 'kube-cluster-hub-openapi-'))
const document = join(directory, 'openapi.json')
const config: Config = {
  publicUrl: 'https://hub.example.test',
  apiUrl: 'https://hub.example.test/api',
  oidcClientId: 'kubernetes-client',
  oidcIssuer: 'https://identity.example.test',
  hubClientId: 'hub-machine-client',
  hubClientSecret: 'not-a-real-secret',
  inventory: { enabled: false, kubeconfig: '', kubeconfigFile: '' },
}

try {
  await writeFile(document, JSON.stringify(hubOpenApi(config), null, 2))
  await command('pnpm', [
    'exec',
    'redocly',
    'lint',
    document,
    '--extends',
    'recommended',
    '--format',
    'stylish',
  ])
} finally {
  await rm(directory, { recursive: true })
}

function command(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${executable} exited with ${code}`)),
    )
  })
}
