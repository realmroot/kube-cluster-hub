import type { Config } from './config'
import { type ProxyDependencies, proxyInventoryRequest } from './dispatch'
import type { Cluster } from './domain'
import { NotFoundError } from './domain'
import type { Store } from './store'

const namespace = 'cluster-inventory'
const apiBase = `/apis/multicluster.x-k8s.io/v1alpha1/namespaces/${namespace}/clusterprofiles`

export class InventoryPublisher {
  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly proxy: ProxyDependencies,
  ) {}

  async reconcile(): Promise<void> {
    if (!this.config.inventoryClusterId) return
    let after = ''
    while (true) {
      const clusters = await this.store.listClusters(after, 200)
      for (const cluster of clusters) await this.publishWithStatus(cluster)
      if (clusters.length < 200) return
      after = clusters.at(-1)?.id ?? ''
    }
  }

  async publishWithStatus(cluster: Cluster): Promise<void> {
    if (!this.config.inventoryClusterId) {
      await this.store.setInventoryPublication(cluster.id, 'not-configured', '')
      return
    }
    try {
      if (!cluster.enabled) {
        await this.delete(cluster.id)
        await this.store.setInventoryPublication(cluster.id, 'disabled', '')
        return
      }
      await this.upsert(cluster)
      await this.store.setInventoryPublication(cluster.id, 'ready', '')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.store.setInventoryPublication(cluster.id, 'error', message)
      console.error(
        JSON.stringify({
          message: 'inventory.publish.error',
          clusterId: cluster.id,
          error: message,
        }),
      )
    }
  }

  async delete(clusterId: string): Promise<void> {
    if (!this.config.inventoryClusterId) return
    const inventory = await this.inventoryCluster(true)
    const response = await proxyInventoryRequest(
      inventory,
      'DELETE',
      `${apiBase}/${encodeURIComponent(clusterId)}`,
      crypto.randomUUID(),
      undefined,
      this.proxy,
    )
    if (!response.ok && response.status !== 404)
      throw new Error(await kubernetesError('delete ClusterProfile', response))
  }

  private async upsert(cluster: Cluster): Promise<void> {
    const inventory = await this.inventoryCluster()
    const requestId = crypto.randomUUID()
    const path = `${apiBase}/${encodeURIComponent(cluster.id)}`
    const current = await proxyInventoryRequest(
      inventory,
      'GET',
      path,
      requestId,
      undefined,
      this.proxy,
    )
    let currentProfile: ClusterProfileDocument | undefined
    if (current.ok) {
      currentProfile = (await current.json()) as ClusterProfileDocument
    } else if (current.status !== 404) {
      throw new Error(await kubernetesError('read ClusterProfile', current))
    }

    const profileMatches = profileIsCurrent(currentProfile, cluster)
    const statusMatches = statusIsCurrent(
      currentProfile,
      cluster,
      this.config.inventoryAccessUrl,
    )
    if (profileMatches && statusMatches) return

    let resourceVersion = currentProfile?.metadata?.resourceVersion
    if (!profileMatches) {
      const profile = clusterProfile(cluster, resourceVersion)
      const written = await proxyInventoryRequest(
        inventory,
        resourceVersion ? 'PUT' : 'POST',
        resourceVersion ? path : apiBase,
        requestId,
        JSON.stringify(profile),
        this.proxy,
      )
      if (!written.ok)
        throw new Error(await kubernetesError('write ClusterProfile', written))
      const saved = (await written.json()) as ClusterProfileDocument
      resourceVersion = saved.metadata?.resourceVersion
    }
    if (statusMatches) return

    const status = clusterProfileStatus(
      cluster,
      this.config.inventoryAccessUrl,
      resourceVersion,
      currentProfile?.status?.conditions?.find(
        (condition) => condition.type === 'ControlPlaneHealthy',
      )?.lastTransitionTime,
    )
    const statusResponse = await proxyInventoryRequest(
      inventory,
      'PUT',
      `${path}/status`,
      requestId,
      JSON.stringify(status),
      this.proxy,
    )
    if (!statusResponse.ok)
      throw new Error(
        await kubernetesError('write ClusterProfile status', statusResponse),
      )
  }

  private async inventoryCluster(allowDisabled = false): Promise<Cluster> {
    try {
      const cluster = await this.store.getCluster(
        this.config.inventoryClusterId,
      )
      if (!allowDisabled && !cluster.enabled)
        throw new Error('inventory cluster is disabled')
      if (cluster.accessMode !== 'connector')
        throw new Error('inventory cluster must use connector mode')
      return cluster
    } catch (error) {
      if (error instanceof NotFoundError)
        throw new Error('configured inventory cluster does not exist')
      throw error
    }
  }
}

function clusterProfile(
  cluster: Cluster,
  resourceVersion: string | undefined,
): object {
  return {
    apiVersion: 'multicluster.x-k8s.io/v1alpha1',
    kind: 'ClusterProfile',
    metadata: {
      name: cluster.id,
      namespace,
      ...(resourceVersion ? { resourceVersion } : {}),
      labels: {
        'multicluster.x-k8s.io/cluster-manager': 'kube-cluster-hub',
      },
    },
    spec: {
      displayName: cluster.displayName,
      clusterManager: { name: 'kube-cluster-hub' },
    },
  }
}

function clusterProfileStatus(
  cluster: Cluster,
  accessUrl: string,
  resourceVersion: string | undefined,
  previousTransitionTime: string | undefined,
): object {
  return {
    apiVersion: 'multicluster.x-k8s.io/v1alpha1',
    kind: 'ClusterProfile',
    metadata: {
      name: cluster.id,
      namespace,
      ...(resourceVersion ? { resourceVersion } : {}),
    },
    status: {
      accessProviders: [
        {
          name: 'oidc-passthrough',
          cluster: { server: `${accessUrl}/clusters/${cluster.id}/kubernetes` },
        },
      ],
      conditions: [
        {
          type: 'ControlPlaneHealthy',
          status: cluster.enabled ? 'True' : 'False',
          reason: cluster.enabled ? 'Published' : 'Disabled',
          message: cluster.enabled
            ? 'Cluster is enabled and published by Kube Cluster Hub'
            : 'Cluster is disabled in Kube Cluster Hub',
          lastTransitionTime:
            previousTransitionTime ?? new Date().toISOString(),
        },
      ],
    },
  }
}

type ClusterProfileDocument = {
  metadata?: {
    resourceVersion?: string
    labels?: Record<string, string>
  }
  spec?: {
    displayName?: string
    clusterManager?: { name?: string }
  }
  status?: {
    accessProviders?: Array<{
      name?: string
      cluster?: { server?: string }
    }>
    conditions?: Array<{
      type?: string
      status?: string
      reason?: string
      message?: string
      lastTransitionTime?: string
    }>
  }
}

function profileIsCurrent(
  current: ClusterProfileDocument | undefined,
  cluster: Cluster,
): boolean {
  return (
    current?.metadata?.labels?.['multicluster.x-k8s.io/cluster-manager'] ===
      'kube-cluster-hub' &&
    current.spec?.displayName === cluster.displayName &&
    current.spec?.clusterManager?.name === 'kube-cluster-hub'
  )
}

function statusIsCurrent(
  current: ClusterProfileDocument | undefined,
  cluster: Cluster,
  accessUrl: string,
): boolean {
  const provider = current?.status?.accessProviders?.find(
    (candidate) => candidate.name === 'oidc-passthrough',
  )
  const condition = current?.status?.conditions?.find(
    (candidate) => candidate.type === 'ControlPlaneHealthy',
  )
  return (
    current?.status?.accessProviders?.length === 1 &&
    provider?.cluster?.server ===
      `${accessUrl}/clusters/${cluster.id}/kubernetes` &&
    condition?.status === 'True' &&
    condition.reason === 'Published' &&
    condition.message === 'Cluster is enabled and published by Kube Cluster Hub'
  )
}

async function kubernetesError(
  operation: string,
  response: Response,
): Promise<string> {
  const detail = (await response.text()).slice(0, 2_000)
  return `${operation} failed with ${response.status}: ${detail}`
}
