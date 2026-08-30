import type { Config } from './config'
import type { Cluster } from './domain'
import type { HubStore } from './store'

export const inventoryManagedByLabel =
  'cluster-inventory.realmroot.dev/managed-by'
export const inventoryManagerName = 'kube-cluster-hub'
const inventoryNamespace = 'cluster-inventory'

export interface ClusterProfileDocument {
  apiVersion: 'multicluster.x-k8s.io/v1alpha1'
  kind: 'ClusterProfile'
  metadata: {
    name: string
    namespace: string
    labels?: Record<string, string>
  }
  spec?: {
    displayName: string
    clusterManager: { name: string }
  }
  status?: {
    accessProviders: Array<{
      name: string
      cluster: { server: string }
    }>
    conditions: Array<{
      type: string
      status: 'True' | 'False' | 'Unknown'
      reason: string
      message: string
      lastTransitionTime: string
    }>
  }
}

export interface InventoryKubernetesClient {
  applyClusterProfile(profile: ClusterProfileDocument): Promise<void>
  applyClusterProfileStatus(profile: ClusterProfileDocument): Promise<void>
  listManagedClusterProfiles(namespace: string): Promise<readonly string[]>
  deleteClusterProfile(namespace: string, name: string): Promise<void>
}

export class InventoryPublisher {
  constructor(
    private readonly config: Config,
    private readonly store: HubStore,
    private readonly client: InventoryKubernetesClient,
  ) {}

  async reconcile(): Promise<void> {
    const desired = new Set<string>()
    let after = ''
    for (;;) {
      const clusters = await this.store.listClusters(after, 200)
      for (const cluster of clusters) {
        if (cluster.enabled) {
          desired.add(cluster.id)
          await this.publish(cluster)
        } else {
          await this.client.deleteClusterProfile(inventoryNamespace, cluster.id)
        }
      }
      if (clusters.length < 200) break
      after = clusters.at(-1)?.id ?? ''
    }

    const published =
      await this.client.listManagedClusterProfiles(inventoryNamespace)
    for (const name of published) {
      if (!desired.has(name)) {
        await this.client.deleteClusterProfile(inventoryNamespace, name)
      }
    }
  }

  async publish(cluster: Cluster): Promise<void> {
    if (!cluster.enabled) {
      await this.client.deleteClusterProfile(inventoryNamespace, cluster.id)
      return
    }
    const profile = this.profile(cluster)
    await this.client.applyClusterProfile(profile)
    await this.client.applyClusterProfileStatus(profile)
  }

  async remove(clusterId: string): Promise<void> {
    await this.client.deleteClusterProfile(inventoryNamespace, clusterId)
  }

  private profile(cluster: Cluster): ClusterProfileDocument {
    return {
      apiVersion: 'multicluster.x-k8s.io/v1alpha1',
      kind: 'ClusterProfile',
      metadata: {
        name: cluster.id,
        namespace: inventoryNamespace,
        labels: {
          [inventoryManagedByLabel]: inventoryManagerName,
          'x-k8s.io/cluster-manager': inventoryManagerName,
        },
      },
      spec: {
        displayName: cluster.displayName,
        clusterManager: { name: inventoryManagerName },
      },
      status: {
        accessProviders: [
          {
            name: 'oidc-passthrough',
            cluster: {
              server: `${this.config.publicUrl}/clusters/${cluster.id}/kubernetes`,
            },
          },
        ],
        conditions: [
          {
            type: 'ControlPlaneHealthy',
            status: 'True',
            reason: 'Published',
            message: 'Cluster access is published by Kube Cluster Hub',
            lastTransitionTime: cluster.updatedAt,
          },
        ],
      },
    }
  }
}
