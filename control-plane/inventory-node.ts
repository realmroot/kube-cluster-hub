import {
  ApiException,
  CustomObjectsApi,
  KubeConfig,
  KubernetesObjectApi,
  PatchStrategy,
} from '@kubernetes/client-node'
import type { Config } from './config'
import {
  type ClusterProfileDocument,
  type InventoryKubernetesClient,
  inventoryManagedByLabel,
  inventoryManagerName,
} from './inventory'

const group = 'multicluster.x-k8s.io'
const version = 'v1alpha1'
const plural = 'clusterprofiles'
const fieldManager = 'kube-cluster-hub'

export class NodeInventoryKubernetesClient
  implements InventoryKubernetesClient
{
  private readonly objects: KubernetesObjectApi
  private readonly custom: CustomObjectsApi

  private constructor(kubeconfig: KubeConfig) {
    this.objects = KubernetesObjectApi.makeApiClient(kubeconfig)
    this.custom = kubeconfig.makeApiClient(CustomObjectsApi)
  }

  static fromConfig(config: Config): NodeInventoryKubernetesClient {
    const kubeconfig = new KubeConfig()
    if (config.inventory.kubeconfig) {
      kubeconfig.loadFromString(config.inventory.kubeconfig)
    } else if (config.inventory.kubeconfigFile) {
      kubeconfig.loadFromFile(config.inventory.kubeconfigFile)
    } else {
      kubeconfig.loadFromCluster()
    }
    return new NodeInventoryKubernetesClient(kubeconfig)
  }

  async applyClusterProfile(profile: ClusterProfileDocument): Promise<void> {
    await this.objects.patch(
      { ...profile, status: undefined },
      undefined,
      undefined,
      fieldManager,
      true,
      PatchStrategy.ServerSideApply,
    )
  }

  async applyClusterProfileStatus(
    profile: ClusterProfileDocument,
  ): Promise<void> {
    await this.custom.patchNamespacedCustomObjectStatus({
      group,
      version,
      namespace: profile.metadata.namespace,
      plural,
      name: profile.metadata.name,
      body: [{ op: 'add', path: '/status', value: profile.status }],
      fieldManager,
    })
  }

  async listManagedClusterProfiles(namespace: string): Promise<string[]> {
    const response: unknown = await this.custom.listNamespacedCustomObject({
      group,
      version,
      namespace,
      plural,
      labelSelector: `${inventoryManagedByLabel}=${inventoryManagerName}`,
    })
    if (!isRecord(response) || !Array.isArray(response.items)) {
      throw new Error('Inventory API returned an invalid ClusterProfile list')
    }
    return response.items.map(profileName)
  }

  async deleteClusterProfile(namespace: string, name: string): Promise<void> {
    try {
      await this.custom.deleteNamespacedCustomObject({
        group,
        version,
        namespace,
        plural,
        name,
      })
    } catch (error) {
      if (error instanceof ApiException && error.code === 404) return
      throw error
    }
  }
}

function profileName(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.metadata)) {
    throw new Error('ClusterProfile item is invalid')
  }
  const name = value.metadata.name
  if (typeof name !== 'string' || !name) {
    throw new Error('ClusterProfile metadata.name is invalid')
  }
  return name
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
