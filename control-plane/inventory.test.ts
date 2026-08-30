import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from './config'
import { NodeDatabaseAdapter } from './database-node'
import { normalizeClusterInput } from './domain'
import {
  type ClusterProfileDocument,
  type InventoryKubernetesClient,
  InventoryPublisher,
} from './inventory'
import { WorkerInventoryKubernetesClient } from './inventory-worker'
import { migrateNodeDatabase } from './migrate-node'
import { Store } from './store'

describe('ClusterProfile publication', () => {
  let database: NodeDatabaseAdapter
  let store: Store
  let client: MemoryInventoryClient

  beforeEach(() => {
    database = new NodeDatabaseAdapter(':memory:')
    migrateNodeDatabase(database)
    store = new Store(database.orm)
    client = new MemoryInventoryClient()
  })

  afterEach(() => database.raw.close())

  it('publishes enabled clusters and removes disabled and orphaned profiles', async () => {
    const active = await store.createCluster('active', clusterInput(true))
    await store.createCluster('disabled', clusterInput(false))
    client.names.add('orphan')
    client.names.add('disabled')
    const publisher = new InventoryPublisher(config(), store, client)

    await publisher.reconcile()

    expect(client.names).toEqual(new Set(['active']))
    expect(client.profiles.get('active')).toEqual({
      apiVersion: 'multicluster.x-k8s.io/v1alpha1',
      kind: 'ClusterProfile',
      metadata: {
        name: 'active',
        namespace: 'cluster-inventory',
        labels: {
          'cluster-inventory.realmroot.dev/managed-by': 'kube-cluster-hub',
          'x-k8s.io/cluster-manager': 'kube-cluster-hub',
        },
      },
      spec: {
        displayName: 'Test cluster',
        clusterManager: { name: 'kube-cluster-hub' },
      },
      status: {
        accessProviders: [
          {
            name: 'oidc-passthrough',
            cluster: {
              server: 'https://hub.example.test/clusters/active/kubernetes',
            },
          },
        ],
        conditions: [
          {
            type: 'ControlPlaneHealthy',
            status: 'True',
            reason: 'Published',
            message: 'Cluster access is published by Kube Cluster Hub',
            lastTransitionTime: active.updatedAt,
          },
        ],
      },
    })
  })

  it('propagates publication failures to the catalog write boundary', async () => {
    const cluster = await store.createCluster('active', clusterInput(true))
    client.failure = new Error('inventory unavailable')
    const publisher = new InventoryPublisher(config(), store, client)

    await expect(publisher.publish(cluster)).rejects.toThrow(
      'inventory unavailable',
    )
  })
})

describe('Worker Inventory Kubernetes transport', () => {
  it('invokes fetch without binding it to the client instance', async () => {
    const fetcher = vi.fn(function (this: unknown) {
      expect(this).toBeUndefined()
      return Promise.resolve(Response.json({ items: [] }))
    }) as unknown as typeof fetch
    const client = WorkerInventoryKubernetesClient.fromConfig(
      config(workerKubeconfig()),
      fetcher,
    )

    await client.listManagedClusterProfiles('cluster-inventory')
  })

  it('uses bearer authentication and Kubernetes apply/status endpoints', async () => {
    const requests: Request[] = []
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      requests.push(new Request(input, init))
      return Response.json({ items: [] })
    })
    const client = WorkerInventoryKubernetesClient.fromConfig(
      config(workerKubeconfig()),
      fetcher,
    )
    const profile = profileFixture()

    await client.applyClusterProfile(profile)
    await client.applyClusterProfileStatus(profile)
    await client.listManagedClusterProfiles('cluster-inventory')
    await client.deleteClusterProfile('cluster-inventory', 'active')

    expect(requests.map((request) => request.method)).toEqual([
      'PATCH',
      'PATCH',
      'GET',
      'DELETE',
    ])
    expect(requests[0]?.url).toContain(
      '/clusterprofiles/active?fieldManager=kube-cluster-hub&force=true',
    )
    expect(requests[1]?.url).toContain('/clusterprofiles/active/status?')
    expect(requests[2]?.url).toContain('labelSelector=')
    for (const request of requests) {
      expect(request.headers.get('Authorization')).toBe(
        'Bearer inventory-token',
      )
    }
  })

  it('rejects kubeconfigs that require unsupported Worker TLS or auth', () => {
    const withCA = workerKubeconfig().replace(
      'server: https://inventory.example.test',
      'server: https://inventory.example.test\n      certificate-authority-data: Y2E=',
    )
    expect(() =>
      WorkerInventoryKubernetesClient.fromConfig(config(withCA)),
    ).toThrow('cannot use custom CA or insecure TLS')
  })
})

class MemoryInventoryClient implements InventoryKubernetesClient {
  readonly profiles = new Map<string, ClusterProfileDocument>()
  readonly names = new Set<string>()
  failure?: Error

  async applyClusterProfile(profile: ClusterProfileDocument): Promise<void> {
    if (this.failure) throw this.failure
    this.profiles.set(profile.metadata.name, structuredClone(profile))
    this.names.add(profile.metadata.name)
  }

  async applyClusterProfileStatus(
    profile: ClusterProfileDocument,
  ): Promise<void> {
    if (this.failure) throw this.failure
    this.profiles.set(profile.metadata.name, structuredClone(profile))
  }

  async listManagedClusterProfiles(): Promise<string[]> {
    return [...this.names]
  }

  async deleteClusterProfile(_namespace: string, name: string): Promise<void> {
    this.names.delete(name)
    this.profiles.delete(name)
  }
}

function config(kubeconfig = '') {
  return loadConfig({
    HUB_PUBLIC_URL: 'https://hub.example.test',
    HUB_UI_CLIENT_ID: 'kubernetes-client',
    OIDC_ISSUER: 'https://identity.example.test',
    TOKEN_EXCHANGE_CLIENT_ID: 'hub-token-exchanger',
    TOKEN_EXCHANGE_CLIENT_SECRET: 'test-secret',
    INVENTORY_ENABLED: 'true',
    INVENTORY_KUBECONFIG: kubeconfig,
  })
}

function clusterInput(enabled: boolean) {
  return normalizeClusterInput({
    displayName: 'Test cluster',
    description: '',
    apiServerUrl: 'https://kubernetes.example.test',
    prometheusUrl: '',
    enabled,
    default: enabled,
  })
}

function workerKubeconfig(): string {
  return `apiVersion: v1
kind: Config
current-context: inventory
clusters:
  - name: inventory
    cluster:
      server: https://inventory.example.test
users:
  - name: publisher
    user:
      token: inventory-token
contexts:
  - name: inventory
    context:
      cluster: inventory
      user: publisher
`
}

function profileFixture(): ClusterProfileDocument {
  return {
    apiVersion: 'multicluster.x-k8s.io/v1alpha1',
    kind: 'ClusterProfile',
    metadata: { name: 'active', namespace: 'cluster-inventory' },
    status: { accessProviders: [], conditions: [] },
  }
}
