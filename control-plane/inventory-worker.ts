import { parse } from 'yaml'
import type { Config } from './config'
import {
  type ClusterProfileDocument,
  type InventoryKubernetesClient,
  inventoryManagedByLabel,
  inventoryManagerName,
} from './inventory'

const apiBase = '/apis/multicluster.x-k8s.io/v1alpha1'

export class WorkerInventoryKubernetesClient
  implements InventoryKubernetesClient
{
  private constructor(
    private readonly server: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch,
  ) {}

  static fromConfig(
    config: Config,
    fetcher: typeof fetch = (input, init) => fetch(input, init),
  ): WorkerInventoryKubernetesClient {
    if (!config.inventory.kubeconfig) {
      throw new Error(
        'INVENTORY_KUBECONFIG is required for Inventory publication on Workers',
      )
    }
    const credential = workerCredential(config.inventory.kubeconfig)
    return new WorkerInventoryKubernetesClient(
      credential.server,
      credential.token,
      fetcher,
    )
  }

  async applyClusterProfile(profile: ClusterProfileDocument): Promise<void> {
    await this.request(
      'PATCH',
      profilePath(profile.metadata.namespace, profile.metadata.name),
      profile,
      'application/apply-patch+yaml',
      '?fieldManager=kube-cluster-hub&force=true',
    )
  }

  async applyClusterProfileStatus(
    profile: ClusterProfileDocument,
  ): Promise<void> {
    await this.request(
      'PATCH',
      `${profilePath(profile.metadata.namespace, profile.metadata.name)}/status`,
      {
        apiVersion: profile.apiVersion,
        kind: profile.kind,
        metadata: profile.metadata,
        status: profile.status,
      },
      'application/apply-patch+yaml',
      '?fieldManager=kube-cluster-hub&force=true',
    )
  }

  async listManagedClusterProfiles(namespace: string): Promise<string[]> {
    const label = encodeURIComponent(
      `${inventoryManagedByLabel}=${inventoryManagerName}`,
    )
    const value = await this.request(
      'GET',
      `${profileCollectionPath(namespace)}?labelSelector=${label}`,
    )
    if (!isRecord(value) || !Array.isArray(value.items)) {
      throw new Error('Inventory API returned an invalid ClusterProfile list')
    }
    return value.items.map(profileName)
  }

  async deleteClusterProfile(namespace: string, name: string): Promise<void> {
    await this.request(
      'DELETE',
      profilePath(namespace, name),
      undefined,
      '',
      '',
      [404],
    )
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    contentType = '',
    query = '',
    acceptedStatuses: readonly number[] = [],
  ): Promise<unknown> {
    const fetcher = this.fetcher
    const response = await fetcher(`${this.server}${path}${query}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        ...(contentType ? { 'Content-Type': contentType } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok && !acceptedStatuses.includes(response.status)) {
      const detail = (await response.text()).slice(0, 2_000)
      throw new Error(
        `Inventory Kubernetes API returned ${response.status}: ${detail}`,
      )
    }
    if (response.status === 204 || response.status === 404) return undefined
    return response.json()
  }
}

interface KubeconfigShape {
  'current-context'?: unknown
  contexts?: unknown
  clusters?: unknown
  users?: unknown
}

function workerCredential(value: string): { server: string; token: string } {
  const document: unknown = parse(value)
  if (!isRecord(document)) throw new Error('INVENTORY_KUBECONFIG is invalid')
  const kubeconfig = document as KubeconfigShape
  const contextName = requiredString(
    kubeconfig['current-context'],
    'current-context',
  )
  const context = namedEntry(kubeconfig.contexts, contextName, 'contexts')
  const contextValue = requiredRecord(context.context, 'context')
  const clusterName = requiredString(contextValue.cluster, 'context.cluster')
  const userName = requiredString(contextValue.user, 'context.user')
  const cluster = requiredRecord(
    namedEntry(kubeconfig.clusters, clusterName, 'clusters').cluster,
    'cluster',
  )
  const user = requiredRecord(
    namedEntry(kubeconfig.users, userName, 'users').user,
    'user',
  )
  const server = requiredString(cluster.server, 'cluster.server').replace(
    /\/$/,
    '',
  )
  const parsed = new URL(server)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error(
      'Worker Inventory Kubernetes API must use public-trusted HTTPS',
    )
  }
  if (
    cluster['certificate-authority'] ||
    cluster['certificate-authority-data'] ||
    cluster['insecure-skip-tls-verify']
  ) {
    throw new Error(
      'Worker Inventory kubeconfig cannot use custom CA or insecure TLS',
    )
  }
  if (
    user.exec ||
    user['auth-provider'] ||
    user['client-certificate'] ||
    user['client-certificate-data'] ||
    user['client-key'] ||
    user['client-key-data']
  ) {
    throw new Error(
      'Worker Inventory kubeconfig supports only a bearer token credential',
    )
  }
  return { server, token: requiredString(user.token, 'user.token') }
}

function namedEntry(value: unknown, name: string, field: string) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  const entry = value.find(
    (candidate) => isRecord(candidate) && candidate.name === name,
  )
  if (!isRecord(entry)) throw new Error(`${field} does not contain ${name}`)
  return entry
}

function requiredRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`)
  return value
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function profileName(value: unknown): string {
  if (!isRecord(value)) throw new Error('ClusterProfile item must be an object')
  const metadata = requiredRecord(value.metadata, 'metadata')
  return requiredString(metadata.name, 'metadata.name')
}

function profileCollectionPath(namespace: string): string {
  return `${apiBase}/namespaces/${encodeURIComponent(namespace)}/clusterprofiles`
}

function profilePath(namespace: string, name: string): string {
  return `${profileCollectionPath(namespace)}/${encodeURIComponent(name)}`
}
