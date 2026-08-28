import { and, asc, desc, eq, gt, lt, ne, sql } from 'drizzle-orm'
import type { DatabaseAdapter, HubDatabase } from './database'
import {
  type AuditEvent,
  type Cluster,
  type ClusterInput,
  ConflictError,
  type ConnectorStatus,
  NotFoundError,
} from './domain'
import { auditEvents, clusters, connectorStatuses, dpopProofs } from './schema'

export class Store {
  private readonly database: HubDatabase

  constructor(database: HubDatabase | DatabaseAdapter) {
    this.database = 'orm' in database ? database.orm : database
  }

  async listClusters(after: string, limit: number): Promise<Cluster[]> {
    return this.database
      .select()
      .from(clusters)
      .where(gt(clusters.id, after))
      .orderBy(asc(clusters.id))
      .limit(limit)
  }

  async getCluster(id: string): Promise<Cluster> {
    const row = await this.database.query.clusters.findFirst({
      where: eq(clusters.id, id),
    })
    if (!row) throw new NotFoundError('cluster not found')
    return row
  }

  async createCluster(id: string, input: ClusterInput): Promise<Cluster> {
    const now = new Date().toISOString()
    const record = {
      id,
      ...input,
      inventoryStatus: 'pending',
      inventoryError: '',
      resourceVersion: 1,
      createdAt: now,
      updatedAt: now,
    }
    try {
      if (input.default) {
        await this.database.batch([
          this.database
            .update(clusters)
            .set({ default: false })
            .where(eq(clusters.default, true)),
          this.database.insert(clusters).values(record),
        ])
      } else await this.database.insert(clusters).values(record)
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
    const update = this.database
      .update(clusters)
      .set({
        ...input,
        inventoryStatus: 'pending',
        inventoryError: '',
        resourceVersion: sql`${clusters.resourceVersion} + 1`,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(eq(clusters.id, id), eq(clusters.resourceVersion, expectedVersion)),
      )
      .returning({ id: clusters.id })
    const rows = input.default
      ? (
          await this.database.batch([
            this.database
              .update(clusters)
              .set({ default: false })
              .where(and(ne(clusters.id, id), eq(clusters.default, true))),
            update,
          ])
        )[1]
      : await update
    if (rows.length !== 1) await this.throwMissingOrConflict(id)
    return this.getCluster(id)
  }

  async deleteCluster(id: string, expectedVersion: number): Promise<void> {
    const rows = await this.database
      .delete(clusters)
      .where(
        and(eq(clusters.id, id), eq(clusters.resourceVersion, expectedVersion)),
      )
      .returning({ id: clusters.id })
    if (rows.length !== 1) await this.throwMissingOrConflict(id)
  }

  async setInventoryPublication(
    id: string,
    status: string,
    error: string,
  ): Promise<void> {
    const rows = await this.database
      .update(clusters)
      .set({ inventoryStatus: status, inventoryError: error })
      .where(eq(clusters.id, id))
      .returning({ id: clusters.id })
    if (rows.length !== 1) throw new NotFoundError('cluster not found')
  }

  async consumeDpopProof(
    thumbprint: string,
    jti: string,
    expiresAt: Date,
  ): Promise<void> {
    const now = new Date().toISOString()
    try {
      await this.database.batch([
        this.database.delete(dpopProofs).where(lt(dpopProofs.expiresAt, now)),
        this.database.insert(dpopProofs).values({
          keyThumbprint: thumbprint,
          jti,
          expiresAt: expiresAt.toISOString(),
          createdAt: now,
        }),
      ])
    } catch (error) {
      const existing = await this.database.query.dpopProofs.findFirst({
        where: and(
          eq(dpopProofs.keyThumbprint, thumbprint),
          eq(dpopProofs.jti, jti),
        ),
        columns: { jti: true },
      })
      if (existing) throw new ConflictError('DPoP proof was already used')
      throw error
    }
  }

  async appendAudit(
    event: Omit<AuditEvent, 'id' | 'createdAt'>,
  ): Promise<void> {
    await this.database
      .insert(auditEvents)
      .values({ ...event, createdAt: new Date().toISOString() })
  }

  async listAuditEvents(
    beforeId: number | undefined,
    limit: number,
  ): Promise<AuditEvent[]> {
    return this.database
      .select()
      .from(auditEvents)
      .where(beforeId === undefined ? undefined : lt(auditEvents.id, beforeId))
      .orderBy(desc(auditEvents.id))
      .limit(limit)
  }

  async pruneAudit(before: Date): Promise<number> {
    const rows = await this.database
      .delete(auditEvents)
      .where(lt(auditEvents.createdAt, before.toISOString()))
      .returning({ id: auditEvents.id })
    return rows.length
  }

  async putConnectorStatus(status: ConnectorStatus): Promise<void> {
    const record = { ...status, capabilities: [...status.capabilities] }
    await this.database
      .insert(connectorStatuses)
      .values(record)
      .onConflictDoUpdate({
        target: connectorStatuses.connectorId,
        set: record,
      })
  }

  async getConnectorStatus(id: string): Promise<ConnectorStatus> {
    const row = await this.database.query.connectorStatuses.findFirst({
      where: eq(connectorStatuses.connectorId, id),
    })
    if (!row) throw new NotFoundError('connector status not found')
    return row
  }

  private async exists(id: string): Promise<boolean> {
    return !!(await this.database.query.clusters.findFirst({
      where: eq(clusters.id, id),
      columns: { id: true },
    }))
  }

  private async throwMissingOrConflict(id: string): Promise<never> {
    if (!(await this.exists(id))) throw new NotFoundError('cluster not found')
    throw new ConflictError('cluster resource version does not match')
  }
}
