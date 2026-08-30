import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { type AppDependencies, createApp } from './app'
import type { Runtime } from './bootstrap'
import { type Config, loadConfig } from './config'
import { NodeDatabaseAdapter } from './database-node'
import {
  type AgentPrincipal,
  normalizeClusterInput,
  type UserPrincipal,
} from './domain'
import { migrateNodeDatabase } from './migrate-node'
import { Store } from './store'
import { attachNodeUpgradeHandler } from './upgrade-node'

const servers: Server[] = []
const databases: NodeDatabaseAdapter[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => close(server)))
  for (const database of databases.splice(0)) database.raw.close()
})

describe('Node HTTP Upgrade proxy', () => {
  it('forwards the user token directly and rejects read-only Agent exec', async () => {
    let upstreamAuthorization = ''
    const upstream = createServer()
    servers.push(upstream)
    upstream.on('upgrade', (request, socket) => {
      upstreamAuthorization = request.headers.authorization || ''
      socket.end(
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nhello',
      )
    })
    const upstreamPort = await listen(upstream)

    const database = new NodeDatabaseAdapter(':memory:')
    databases.push(database)
    migrateNodeDatabase(database)
    const store = new Store(database.orm)
    const config = testConfig()
    await store.createCluster(
      'development',
      normalizeClusterInput({
        displayName: 'Development',
        apiServerUrl: `http://127.0.0.1:${upstreamPort}`,
      }),
    )
    const user: UserPrincipal = {
      type: 'user',
      subject: 'user-1',
      scopes: ['clusters:read'],
      token: 'user-id-token',
    }
    const readOnlyAgent: AgentPrincipal = {
      type: 'agent',
      controllerSubject: 'controller-1',
      actor: { issuer: config.oidcIssuer, subject: 'agent-1' },
      clientId: 'authorized-toolbox-client',
      scopes: ['kubernetes:read'],
      scope: 'kubernetes:read',
      tokenId: 'token-1',
      token: 'agent-access-token',
      expiresAt: Math.floor(Date.now() / 1_000) + 300,
    }
    const dependencies: AppDependencies = {
      config,
      store,
      catalogUsers: { verify: async () => user },
      kubernetesUsers: { verify: async () => user },
      agents: { verify: async () => readOnlyAgent },
      agentTokens: {
        exchange: async () => ({
          token: 'kubernetes-id-token',
          targetAudience: config.oidcClientId,
          groups: [],
        }),
      },
      proxy: { fetch },
    }
    const runtime: Runtime = {
      config,
      store,
      dependencies,
      app: createApp(dependencies),
    }
    const hub = createServer((_request, response) =>
      response.writeHead(404).end(),
    )
    servers.push(hub)
    attachNodeUpgradeHandler(hub, runtime)
    const hubPort = await listen(hub)

    const response = await rawUpgrade(
      hubPort,
      '/clusters/development/kubernetes/api/v1/namespaces/default/pods/app/exec?command=sh',
      'Bearer user-id-token',
    )
    expect(response).toContain('101 Switching Protocols')
    expect(response).toContain('hello')
    expect(upstreamAuthorization).toBe('Bearer user-id-token')

    const denied = await rawUpgrade(
      hubPort,
      '/api/clusters/development/kubernetes/api/v1/namespaces/default/pods/app/exec?command=sh',
      'DPoP agent-token',
      'proof',
    )
    expect(denied).toContain('403 Upgrade failed')
    expect(denied).toContain('kubernetes:write is required')
  })
})

function testConfig(): Config {
  return loadConfig({
    HUB_PUBLIC_URL: 'http://127.0.0.1:8080',
    OIDC_CLIENT_ID: 'kubernetes-client',
    OIDC_ISSUER: 'https://identity.example.test',
    HUB_CLIENT_ID: 'hub-machine-client',
    HUB_CLIENT_SECRET: 'test-secret',
  })
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('server did not bind TCP')
  return address.port
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  server.close()
  await once(server, 'close')
}

async function rawUpgrade(
  port: number,
  path: string,
  authorization: string,
  dpop?: string,
): Promise<string> {
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: ${authorization}\r\n${dpop ? `DPoP: ${dpop}\r\n` : ''}\r\n`,
  )
  const chunks: Uint8Array[] = []
  socket.on('data', (chunk: Uint8Array) => chunks.push(chunk))
  await once(socket, 'close')
  return Buffer.concat(chunks).toString()
}
