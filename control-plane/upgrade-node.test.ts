import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { exportJWK, generateKeyPair, jwtVerify } from 'jose'
import { afterEach, describe, expect, it } from 'vitest'
import { type AppDependencies, createApp } from './app'
import type { Runtime } from './bootstrap'
import { type Config, loadConfig } from './config'
import { NodeDatabaseAdapter } from './database-node'
import { DispatchSigner } from './dispatch'
import {
  type AgentPrincipal,
  normalizeClusterInput,
  type UserPrincipal,
} from './domain'
import { InventoryPublisher } from './inventory'
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
  it('bridges a Connector WebSocket with a request-bound dispatch and rejects read-only Agent exec', async () => {
    let upstreamAuthorization = ''
    let upstreamUserAuthorization = ''
    const upstream = createServer()
    servers.push(upstream)
    upstream.on('upgrade', (request, socket) => {
      upstreamAuthorization = request.headers.authorization || ''
      upstreamUserAuthorization = String(
        request.headers['x-cluster-authorization'] || '',
      )
      socket.end(
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nhello',
      )
    })
    const upstreamPort = await listen(upstream)

    const database = new NodeDatabaseAdapter(':memory:')
    databases.push(database)
    migrateNodeDatabase(database)
    const store = new Store(database)
    const { config, publicKey } = await testConfig()
    await store.createCluster(
      'development',
      normalizeClusterInput({
        displayName: 'Development',
        apiServerUrl: '',
        accessMode: 'connector',
        connectorId: 'development',
        connectorUrl: `http://127.0.0.1:${upstreamPort}`,
      }),
    )
    const user: UserPrincipal = {
      type: 'user',
      subject: 'user-1',
      groups: [],
      scopes: ['clusters:read', 'clusters:write', 'audit-events:read'],
      token: 'user-id-token',
    }
    const readOnlyAgent: AgentPrincipal = {
      type: 'agent',
      controllerSubject: 'controller-1',
      actor: {
        issuer: config.resourceIssuer,
        subject: 'agent-1',
      },
      clientId: 'authorized-toolbox-client',
      scopes: ['kubernetes:read'],
      scope: 'kubernetes:read',
      tokenId: 'token-1',
    }
    const signer = await DispatchSigner.create(config)
    const dependencies: AppDependencies = {
      config,
      store,
      catalogUsers: { verify: async () => user },
      kubernetesUsers: { verify: async () => user },
      agents: { verify: async () => readOnlyAgent },
      proxy: { signer, fetch },
      inventory: {
        publishWithStatus: async () => undefined,
        delete: async () => undefined,
      },
    }
    const inventory = new InventoryPublisher(config, store, dependencies.proxy)
    const runtime: Runtime = {
      config,
      store,
      inventory,
      dependencies,
      app: createApp(dependencies),
    }
    const controlPlane = createServer((_request, response) =>
      response.writeHead(404).end(),
    )
    servers.push(controlPlane)
    attachNodeUpgradeHandler(controlPlane, runtime)
    const controlPlanePort = await listen(controlPlane)

    const response = await rawUpgrade(
      controlPlanePort,
      '/clusters/development/kubernetes/api/v1/namespaces/default/pods/app/exec?command=sh',
      'Bearer user-id-token',
    )
    expect(response).toContain('101 Switching Protocols')
    expect(response).toContain('hello')
    expect(upstreamUserAuthorization).toBe('Bearer user-id-token')
    const dispatch = upstreamAuthorization.slice('Bearer '.length)
    const verified = await jwtVerify(dispatch, publicKey, {
      issuer: config.dispatchIssuer,
      audience: config.dispatchAudience,
    })
    expect(verified.payload).toMatchObject({
      cluster_id: 'development',
      uri: '/api/v1/namespaces/default/pods/app/exec?command=sh',
      principal_type: 'user',
    })

    const denied = await rawUpgrade(
      controlPlanePort,
      '/api/agent/clusters/development/kubernetes/api/v1/namespaces/default/pods/app/exec?command=sh',
      'DPoP agent-token',
      'proof',
    )
    expect(denied).toContain('403 Upgrade failed')
    expect(denied).toContain('kubernetes:write is required')
  })
})

async function testConfig(): Promise<{ config: Config; publicKey: CryptoKey }> {
  const pair = await generateKeyPair('ES256', { extractable: true })
  const privateJwk = await exportJWK(pair.privateKey)
  privateJwk.kid = 'dispatch-test'
  privateJwk.alg = 'ES256'
  return {
    publicKey: pair.publicKey,
    config: loadConfig({
      HUB_PUBLIC_URL: 'http://127.0.0.1:8080',
      HUB_UI_CLIENT_ID: 'kubernetes-client',
      OIDC_ISSUER: 'https://identity.example.test',
      KUBERNETES_OIDC_AUDIENCE: 'kubernetes-client',
      CATALOG_ADMIN_GROUPS: 'platform-admins',
      RESOURCE_SERVER_ISSUER: 'https://identity.example.test',
      RESOURCE_SERVER_AUTHORIZED_CLIENT_IDS: 'authorized-toolbox-client',
      DISPATCH_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk),
      CONNECTOR_STATUS_TOKEN: 'status-secret',
    }),
  }
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
  const chunks: Buffer[] = []
  socket.on('data', (chunk) => chunks.push(chunk))
  await once(socket, 'close')
  return Buffer.concat(chunks).toString()
}
