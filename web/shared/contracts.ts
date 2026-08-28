import { z } from 'zod'

export const uiConfigSchema = z.object({
  issuer: z.string().url(),
  clientId: z.string().min(1),
  resource: z.string().url(),
  scopes: z.array(z.string().min(1)),
  apiVersion: z.string().min(1),
})
export type UiConfig = z.infer<typeof uiConfigSchema>

export const clusterSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string(),
  apiServerUrl: z.string(),
  prometheusUrl: z.string(),
  accessMode: z.enum(['direct', 'connector']),
  connectorId: z.string(),
  connectorUrl: z.string(),
  enabled: z.boolean(),
  default: z.boolean(),
  inventoryStatus: z.string(),
  inventoryError: z.string(),
  resourceVersion: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Cluster = z.infer<typeof clusterSchema>
export type ClusterInput = Pick<
  Cluster,
  | 'displayName'
  | 'description'
  | 'apiServerUrl'
  | 'prometheusUrl'
  | 'accessMode'
  | 'connectorId'
  | 'connectorUrl'
  | 'enabled'
  | 'default'
>

export const auditEventSchema = z.object({
  id: z.number(),
  createdAt: z.string(),
  requestId: z.string(),
  tokenId: z.string(),
  principalType: z.enum(['user', 'agent']),
  controllerSubject: z.string(),
  agentIssuer: z.string(),
  agentSubject: z.string(),
  userSubject: z.string(),
  clientId: z.string(),
  scopes: z.string(),
  clusterId: z.string(),
  method: z.string(),
  path: z.string(),
  status: z.number(),
  durationMillis: z.number(),
})
export type AuditEvent = z.infer<typeof auditEventSchema>

export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    pagination: z.object({
      pageSize: z.number(),
      nextPageToken: z.string().optional(),
    }),
  })
