import {
  auditEventSchema,
  type Cluster,
  type ClusterInput,
  clusterSchema,
  pageSchema,
  type UiConfig,
} from './contracts'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export class HubApi {
  constructor(
    private readonly config: UiConfig,
    private readonly token: string,
  ) {}

  listClusters() {
    return this.request('/clusters', pageSchema(clusterSchema))
  }
  listAuditEvents() {
    return this.request('/audit-events', pageSchema(auditEventSchema))
  }
  async saveCluster(id: string, input: ClusterInput, version?: number) {
    return this.request(`/clusters/${encodeURIComponent(id)}`, clusterSchema, {
      method: 'PUT',
      headers:
        version === undefined
          ? { 'If-None-Match': '*' }
          : { 'If-Match': `"${version}"` },
      body: JSON.stringify(input),
    })
  }
  async deleteCluster(cluster: Cluster) {
    await this.request(`/clusters/${encodeURIComponent(cluster.id)}`, null, {
      method: 'DELETE',
      headers: { 'If-Match': `"${cluster.resourceVersion}"` },
    })
  }

  private async request<T>(
    path: string,
    schema: { parse(value: unknown): T } | null,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(`${this.config.resource}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'API-Version': this.config.apiVersion,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    })
    if (!response.ok) {
      const problem = (await response.json().catch(() => null)) as {
        detail?: string
      } | null
      throw new ApiError(
        response.status,
        problem?.detail || `Request failed with ${response.status}`,
      )
    }
    if (!schema) return undefined as T
    return schema.parse(await response.json())
  }
}
