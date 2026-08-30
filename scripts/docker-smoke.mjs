import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

const image = 'kube-cluster-hub:verify'
const container = `kube-cluster-hub-verify-${randomUUID()}`
const issuerPort = await availablePort()
const hubPort = await availablePort()
const issuer = `http://host.docker.internal:${issuerPort}`

const oidc = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json')
  if (request.url === '/.well-known/openid-configuration') {
    response.end(
      JSON.stringify({
        issuer,
        jwks_uri: `${issuer}/jwks`,
        token_endpoint: `${issuer}/token`,
      }),
    )
    return
  }
  if (request.url === '/jwks') {
    response.end(JSON.stringify({ keys: [] }))
    return
  }
  response.statusCode = 404
  response.end(JSON.stringify({ error: 'not_found' }))
})

await listen(oidc, issuerPort)
try {
  await command('docker', ['build', '-t', image, '.'])
  await command('docker', [
    'run',
    '--rm',
    '--detach',
    '--name',
    container,
    '--add-host',
    'host.docker.internal:host-gateway',
    '--publish',
    `127.0.0.1:${hubPort}:8080`,
    '--env',
    'HUB_PUBLIC_URL=http://hub.example.test',
    '--env',
    `OIDC_ISSUER=${issuer}`,
    '--env',
    'OIDC_CLIENT_ID=kubernetes-client',
    '--env',
    'HUB_CLIENT_ID=hub-machine-client',
    '--env',
    'HUB_CLIENT_SECRET=not-a-real-secret',
    image,
  ])

  await eventually(async () => {
    const [health, readiness, ui] = await Promise.all([
      fetch(`http://127.0.0.1:${hubPort}/healthz`),
      fetch(`http://127.0.0.1:${hubPort}/readyz`),
      fetch(`http://127.0.0.1:${hubPort}/`),
    ])
    if (health.status !== 204 || readiness.status !== 204 || !ui.ok)
      throw new Error(
        `unexpected status health=${health.status} readiness=${readiness.status} ui=${ui.status}`,
      )
  })

  const identity = spawnSync(
    'docker',
    ['exec', container, 'node', '-e', 'console.log(process.getuid())'],
    { encoding: 'utf8' },
  )
  if (identity.status !== 0 || identity.stdout.trim() !== '65532')
    throw new Error('production container is not running as uid 65532')
  console.log(
    'Docker image health, readiness, UI, SQLite, and uid checks passed',
  )
} catch (error) {
  const logs = spawnSync('docker', ['logs', container], { encoding: 'utf8' })
  if (logs.stdout) process.stderr.write(logs.stdout)
  if (logs.stderr) process.stderr.write(logs.stderr)
  throw error
} finally {
  oidc.close()
  spawnSync('docker', ['stop', '--time', '5', container], { stdio: 'ignore' })
  spawnSync('docker', ['rm', '--force', '--volumes', container], {
    stdio: 'ignore',
  })
}

async function availablePort() {
  const server = createServer()
  await listen(server, 0)
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('failed to allocate a TCP port')
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return address.port
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', resolve)
  })
}

function command(executable, args) {
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

async function eventually(check) {
  let lastError
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await check()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw lastError
}
