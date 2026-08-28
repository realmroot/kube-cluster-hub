import { and, asc, desc, eq, gt, lt, ne, sql } from 'drizzle-orm'
import type { HubDatabase } from './database'
import {
  type AuditEvent,
  type Cluster,
  type ClusterInput,
  ConflictError,
  NotFoundError,
} from './domain'
import { auditEvents, clusters, dpopProofs } from './schema'

export class Store implements HubStore {
  private readonly database: HubDatabase

  constructor(database: HubDatabase) {
    this.database = database
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

export interface HubStore {
  listClusters(after: string, limit: number): Promise<Cluster[]>
  getCluster(id: string): Promise<Cluster>
  createCluster(id: string, input: ClusterInput): Promise<Cluster>
  replaceCluster(
    id: string,
    input: ClusterInput,
    expectedVersion: number,
  ): Promise<Cluster>
  deleteCluster(id: string, expectedVersion: number): Promise<void>
  consumeDpopProof(
    thumbprint: string,
    jti: string,
    expiresAt: Date,
  ): Promise<void>
  appendAudit(event: Omit<AuditEvent, 'id' | 'createdAt'>): Promise<void>
  listAuditEvents(
    beforeId: number | undefined,
    limit: number,
  ): Promise<AuditEvent[]>
  pruneAudit(before: Date): Promise<number>
}
