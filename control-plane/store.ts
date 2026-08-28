import type { Database, SQLValue } from './database'
import {
  type AuditEvent,
  type Cluster,
  type ClusterInput,
  ConflictError,
  type ConnectorStatus,
  NotFoundError,
} from './domain'

interface ClusterRow {
  id: string
  display_name: string
  description: string
  api_server_url: string
  prometheus_url: string
  access_mode: 'direct' | 'connector'
  connector_id: string
  connector_url: string
  enabled: number
  is_default: number
  inventory_status: string
  inventory_error: string
  resource_version: number
  created_at: string
  updated_at: string
}

interface AuditRow {
  id: number
  created_at: string
  request_id: string
  token_id: string
  principal_type: 'user' | 'agent'
  controller_subject: string
  agent_issuer: string
  agent_subject: string
  user_subject: string
  client_id: string
  scopes: string
  cluster_id: string
  method: string
  path: string
  status: number
  duration_millis: number
}

interface ConnectorStatusRow {
  connector_id: string
  cluster_id: string
  version: string
  kubernetes_version: string
  capabilities: string
  state: 'ready' | 'degraded'
  last_error: string
  observed_at: string
}

const clusterColumns = `id, display_name, description, api_server_url, prometheus_url,
  access_mode, connector_id, connector_url, enabled, is_default, inventory_status,
  inventory_error, resource_version, created_at, updated_at`

export class Store {
  constructor(private readonly database: Database) {}

  async listClusters(after: string, limit: number): Promise<Cluster[]> {
    const rows = await this.database.all<ClusterRow>(
      `SELECT ${clusterColumns} FROM clusters WHERE id > ? ORDER BY id ASC LIMIT ?`,
      [after, limit],
    )
    return rows.map(clusterFromRow)
  }

  async getCluster(id: string): Promise<Cluster> {
    const row = await this.database.first<ClusterRow>(
      `SELECT ${clusterColumns} FROM clusters WHERE id = ?`,
      [id],
    )
    if (!row) throw new NotFoundError('cluster not found')
    return clusterFromRow(row)
  }

  async createCluster(id: string, input: ClusterInput): Promise<Cluster> {
    const now = new Date().toISOString()
    const statements = []
    if (input.default)
      statements.push({
        sql: 'UPDATE clusters SET is_default = 0 WHERE is_default = 1',
      })
    statements.push({
      sql: `INSERT INTO clusters (${clusterColumns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', 1, ?, ?)`,
      values: clusterValues(id, input, now),
    })
    try {
      await this.database.batch(statements)
    } catch (error) {
      if (await this.exists(id))
        throw new ConflictError('cluster already exists')
      throw error
    }
    return this.getCluster(id)
  }

  async replaceCluster(
    id: string,
    input: ClusterInput,
    expectedVersion: number,
  ): Promise<Cluster> {
    const now = new Date().toISOString()
    const statements = []
    if (input.default)
      statements.push({
        sql: 'UPDATE clusters SET is_default = 0 WHERE id <> ?',
        values: [id],
      })
    statements.push({
      sql: `UPDATE clusters SET display_name = ?, description = ?, api_server_url = ?,
        prometheus_url = ?, access_mode = ?, connector_id = ?, connector_url = ?,
        enabled = ?, is_default = ?, inventory_status = 'pending', inventory_error = '',
        resource_version = resource_version + 1, updated_at = ? WHERE id = ? AND resource_version = ?`,
      values: [...inputValues(input), now, id, expectedVersion],
    })
    const results = await this.database.batch(statements)
    if (results.at(-1)?.changes !== 1) {
      if (!(await this.exists(id))) throw new NotFoundError('cluster not found')
      throw new ConflictError('cluster resource version does not match')
    }
    return this.getCluster(id)
  }

  async deleteCluster(id: string, expectedVersion: number): Promise<void> {
    const result = await this.database.run(
      'DELETE FROM clusters WHERE id = ? AND resource_version = ?',
      [id, expectedVersion],
    )
    if (result.changes === 1) return
    if (!(await this.exists(id))) throw new NotFoundError('cluster not found')
    throw new ConflictError('cluster resource version does not match')
  }

  async setInventoryPublication(
    id: string,
    status: string,
    error: string,
  ): Promise<void> {
    const result = await this.database.run(
      'UPDATE clusters SET inventory_status = ?, inventory_error = ? WHERE id = ?',
      [status, error, id],
    )
    if (result.changes !== 1) throw new NotFoundError('cluster not found')
  }

  async consumeDpopProof(
    thumbprint: string,
    jti: string,
    expiresAt: Date,
  ): Promise<void> {
    const now = new Date().toISOString()
    await this.database.run('DELETE FROM d_po_p_proofs WHERE expires_at <= ?', [
      now,
    ])
    try {
      await this.database.run(
        'INSERT INTO d_po_p_proofs (key_thumbprint, jti, expires_at, created_at) VALUES (?, ?, ?, ?)',
        [thumbprint, jti, expiresAt.toISOString(), now],
      )
    } catch (error) {
      const existing = await this.database.first<{ present: number }>(
        'SELECT 1 AS present FROM d_po_p_proofs WHERE key_thumbprint = ? AND jti = ?',
        [thumbprint, jti],
      )
      if (existing) throw new ConflictError('DPoP proof was already used')
      throw error
    }
  }

  async appendAudit(
    event: Omit<AuditEvent, 'id' | 'createdAt'>,
  ): Promise<void> {
    await this.database.run(
      `INSERT INTO audit_events (created_at, request_id, token_id, principal_type, controller_subject,
        agent_issuer, agent_subject, user_subject, client_id, scopes, cluster_id, method, path, status,
        duration_millis) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        new Date().toISOString(),
        event.requestId,
        event.tokenId,
        event.principalType,
        event.controllerSubject,
        event.agentIssuer,
        event.agentSubject,
        event.userSubject,
        event.clientId,
        event.scopes,
        event.clusterId,
        event.method,
        event.path,
        event.status,
        event.durationMillis,
      ],
    )
  }

  async listAuditEvents(
    beforeId: number | undefined,
    limit: number,
  ): Promise<AuditEvent[]> {
    const condition = beforeId === undefined ? '' : 'WHERE id < ?'
    const values: SQLValue[] =
      beforeId === undefined ? [limit] : [beforeId, limit]
    const rows = await this.database.all<AuditRow>(
      `SELECT * FROM audit_events ${condition} ORDER BY id DESC LIMIT ?`,
      values,
    )
    return rows.map(auditFromRow)
  }

  async pruneAudit(before: Date): Promise<number> {
    return (
      await this.database.run('DELETE FROM audit_events WHERE created_at < ?', [
        before.toISOString(),
      ])
    ).changes
  }

  async putConnectorStatus(status: ConnectorStatus): Promise<void> {
    await this.database.run(
      `INSERT INTO connector_statuses (connector_id, cluster_id, version, kubernetes_version, capabilities,
        state, last_error, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(connector_id) DO UPDATE SET cluster_id = excluded.cluster_id, version = excluded.version,
        kubernetes_version = excluded.kubernetes_version, capabilities = excluded.capabilities,
        state = excluded.state, last_error = excluded.last_error, observed_at = excluded.observed_at`,
      [
        status.connectorId,
        status.clusterId,
        status.version,
        status.kubernetesVersion,
        JSON.stringify(status.capabilities),
        status.state,
        status.lastError,
        status.observedAt,
      ],
    )
  }

  async getConnectorStatus(id: string): Promise<ConnectorStatus> {
    const row = await this.database.first<ConnectorStatusRow>(
      'SELECT * FROM connector_statuses WHERE connector_id = ?',
      [id],
    )
    if (!row) throw new NotFoundError('connector status not found')
    return {
      connectorId: row.connector_id,
      clusterId: row.cluster_id,
      version: row.version,
      kubernetesVersion: row.kubernetes_version,
      capabilities: JSON.parse(row.capabilities) as string[],
      state: row.state,
      lastError: row.last_error,
      observedAt: row.observed_at,
    }
  }

  private async exists(id: string): Promise<boolean> {
    return !!(await this.database.first<{ present: number }>(
      'SELECT 1 AS present FROM clusters WHERE id = ?',
      [id],
    ))
  }
}

function inputValues(input: ClusterInput): SQLValue[] {
  return [
    input.displayName,
    input.description,
    input.apiServerUrl,
    input.prometheusUrl,
    input.accessMode,
    input.connectorId,
    input.connectorUrl,
    input.enabled ? 1 : 0,
    input.default ? 1 : 0,
  ]
}

function clusterValues(
  id: string,
  input: ClusterInput,
  now: string,
): SQLValue[] {
  return [id, ...inputValues(input), now, now]
}

function clusterFromRow(row: ClusterRow): Cluster {
  return {
    id: row.id,
    displayName: row.display_name,
    description: row.description,
    apiServerUrl: row.api_server_url,
    prometheusUrl: row.prometheus_url,
    accessMode: row.access_mode,
    connectorId: row.connector_id,
    connectorUrl: row.connector_url,
    enabled: row.enabled === 1,
    default: row.is_default === 1,
    inventoryStatus: row.inventory_status,
    inventoryError: row.inventory_error,
    resourceVersion: row.resource_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function auditFromRow(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    createdAt: row.created_at,
    requestId: row.request_id,
    tokenId: row.token_id,
    principalType: row.principal_type,
    controllerSubject: row.controller_subject,
    agentIssuer: row.agent_issuer,
    agentSubject: row.agent_subject,
    userSubject: row.user_subject,
    clientId: row.client_id,
    scopes: row.scopes,
    clusterId: row.cluster_id,
    method: row.method,
    path: row.path,
    status: row.status,
    durationMillis: row.duration_millis,
  }
}
