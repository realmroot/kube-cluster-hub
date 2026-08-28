import { exportJWK, generateKeyPair } from 'jose'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config'
import { NodeDatabaseAdapter } from './database-node'
import { DispatchSigner } from './dispatch'
import { normalizeClusterInput } from './domain'
import { InventoryPublisher } from './inventory'
import { migrateNodeDatabase } from './migrate-node'
import { Store } from './store'

describe('ClusterProfile publication', () => {
  let database: NodeDatabaseAdapter
  let store: Store

  beforeEach(() => {
    database = new NodeDatabaseAdapter(':memory:')
    migrateNodeDatabase(database)
    store = new Store(database)
  })

  afterEach(() => database.raw.close())

  it('is idempotent and removes a disabled cluster', async () => {
    const pair = await generateKeyPair('ES256', { extractable: true })
    const privateJwk = await exportJWK(pair.privateKey)
    privateJwk.kid = 'inventory-test'
    privateJwk.alg = 'ES256'
    const config = loadConfig({
      GATEWAY_PUBLIC_URL: 'https://gateway.example.com',
      OIDC_ISSUER: 'https://identity.example.com',
      OIDC_AUDIENCE: 'kubernetes-client',
      CATALOG_ADMIN_GROUPS: 'platform-admins',
      RESOURCE_SERVER_ISSUER: 'https://identity.example.com',
      RESOURCE_SERVER_AUTHORIZED_CLIENT_IDS: 'toolbox-client',
      DISPATCH_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk),
      CONNECTOR_STATUS_TOKEN: 'status-secret',
      INVENTORY_CLUSTER_ID: 'management',
    })
    const input = normalizeClusterInput({
      displayName: 'Management',
      description: '',
      apiServerUrl: '',
      prometheusUrl: '',
      accessMode: 'connector',
      connectorId: 'management',
      connectorUrl: 'http://127.0.0.1:18082',
      enabled: true,
      default: true,
    })
    let cluster = await store.createCluster('management', input)
    let profile: Record<string, unknown> | undefined
    const methods: string[] = []
    const fetcher: typeof fetch = async (request) => {
      const outgoing = new Request(request)
      methods.push(outgoing.method)
      if (outgoing.method === 'GET') {
        return profile
          ? json(profile)
          : new Response('not found', { status: 404 })
      }
      if (outgoing.method === 'DELETE') {
        profile = undefined
        return new Response(null, { status: 200 })
      }
      const body = (await outgoing.json()) as Record<string, unknown>
      const metadata = (body.metadata ?? {}) as Record<string, unknown>
      const currentMetadata = (profile?.metadata ?? {}) as Record<
        string,
        unknown
      >
      const nextVersion = String(
        Number(
          ((profile?.metadata ?? {}) as Record<string, unknown>)
            .resourceVersion ?? 0,
        ) + 1,
      )
      if (outgoing.url.endsWith('/status')) {
        profile = {
          ...profile,
          status: body.status,
          metadata: {
            ...currentMetadata,
            ...metadata,
            resourceVersion: nextVersion,
          },
        }
      } else {
        profile = {
          ...body,
          status: profile?.status,
          metadata: { ...metadata, resourceVersion: nextVersion },
        }
      }
      return json(profile)
    }
    const publisher = new InventoryPublisher(config, store, {
      signer: await DispatchSigner.create(config),
      fetch: fetcher,
    })

    await publisher.publishWithStatus(cluster)
    expect(methods).toEqual(['GET', 'POST', 'PUT'])
    methods.length = 0

    cluster = await store.getCluster('management')
    const transitionTime = conditionTransitionTime(profile)
    await publisher.publishWithStatus(cluster)
    expect(methods).toEqual(['GET'])
    expect(conditionTransitionTime(profile)).toBe(transitionTime)

    cluster = await store.replaceCluster(
      'management',
      { ...input, enabled: false, default: false },
      cluster.resourceVersion,
    )
    methods.length = 0
    await publisher.publishWithStatus(cluster)
    expect(methods).toEqual(['DELETE'])
    expect(profile).toBeUndefined()
    expect((await store.getCluster('management')).inventoryStatus).toBe(
      'disabled',
    )
  })
})

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function conditionTransitionTime(
  profile: Record<string, unknown> | undefined,
): unknown {
  const status = (profile?.status ?? {}) as {
    conditions?: Array<{ lastTransitionTime?: string }>
  }
  return status.conditions?.[0]?.lastTransitionTime
}
