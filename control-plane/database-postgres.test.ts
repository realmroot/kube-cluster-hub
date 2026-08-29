import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresDatabaseAdapter } from './database-postgres'
import { normalizeClusterInput } from './domain'
import type { HubStore } from './store'

const url = process.env.HUB_POSTGRES_TEST_URL
let database: PostgresDatabaseAdapter
let secondDatabase: PostgresDatabaseAdapter
let store: HubStore
let secondStore: HubStore

describe.skipIf(!url)('PostgreSQL persistence adapter', () => {
  beforeAll(async () => {
    database = new PostgresDatabaseAdapter(url || '')
    secondDatabase = new PostgresDatabaseAdapter(url || '')
    await Promise.all([database.migrate(), secondDatabase.migrate()])
    store = database.createStore()
    secondStore = secondDatabase.createStore()
  })

  afterAll(async () => Promise.all([database.close(), secondDatabase.close()]))

  it('shares catalog concurrency, replay, and audit semantics', async () => {
    const suffix = crypto.randomUUID().slice(0, 8)
    const first = await store.createCluster(
      `postgres-first-${suffix}`,
      normalizeClusterInput({
        displayName: 'PostgreSQL first',
        apiServerUrl: 'https://first.example.test',
        default: true,
      }),
    )
    await store.createCluster(
      `postgres-second-${suffix}`,
      normalizeClusterInput({
        displayName: 'PostgreSQL second',
        apiServerUrl: 'https://second.example.test',
        default: true,
      }),
    )
    expect((await secondStore.getCluster(first.id)).default).toBe(false)
    await expect(
      store.replaceCluster(
        first.id,
        normalizeClusterInput({
          displayName: 'Stale',
          apiServerUrl: 'https://first.example.test',
        }),
        99,
      ),
    ).rejects.toThrow('resource version')

    const expiry = new Date(Date.now() + 60_000)
    const replayResults = await Promise.allSettled([
      store.consumeDpopProof('postgres-thumbprint', suffix, expiry),
      secondStore.consumeDpopProof('postgres-thumbprint', suffix, expiry),
    ])
    expect(
      replayResults.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1)
    expect(
      replayResults.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1)

    await store.appendAudit({
      requestId: `postgres-request-${suffix}`,
      tokenId: 'postgres-token',
      principalType: 'agent',
      controllerSubject: 'controller',
      agentIssuer: 'https://identity.example.test',
      agentSubject: 'agent',
      userSubject: '',
      clientId: 'toolbox',
      scopes: 'kubernetes:read',
      clusterId: first.id,
      method: 'GET',
      path: '/api/v1/pods',
      status: 200,
      durationMillis: 1,
      exchangeStatus: 'succeeded',
      targetAudience: 'kubernetes-client',
    })
    expect(await store.listAuditEvents(undefined, 10)).toContainEqual(
      expect.objectContaining({
        requestId: `postgres-request-${suffix}`,
        status: 200,
      }),
    )
  })
})
