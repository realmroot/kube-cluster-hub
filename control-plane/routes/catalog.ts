import type { AppDependencies, HubApp } from '../app-dependencies'
import { scopes } from '../contracts'
import type { AgentPrincipal, Cluster, UserPrincipal } from '../domain'
import { normalizeClusterInput, validateClusterId } from '../domain'
import {
  auditStatus,
  boundedJson,
  catalogVersion,
  etag,
  parseEtag,
  requireAgentScope,
  requireUserScope,
} from '../http'
import { auditForAgent, auditForUser, verifyAgent } from './access'
import { auditPage, clusterPage } from './pages'

export function registerCatalogRoutes(
  app: HubApp,
  dependencies: AppDependencies,
): void {
  app.use('/api/clusters', catalogVersion)
  app.use('/api/clusters/*', catalogVersion)
  app.use('/api/audit-events', catalogVersion)

  app.get('/api/clusters', (context) =>
    readForUserOrAgent(context, dependencies, scopes.clustersRead, '', () =>
      clusterPage(
        context,
        dependencies.store,
        `${dependencies.config.apiUrl}/clusters`,
      ),
    ),
  )

  app.get('/api/clusters/:clusterId', (context) =>
    readForUserOrAgent(
      context,
      dependencies,
      scopes.clustersRead,
      context.req.param('clusterId'),
      async () => {
        const cluster = await dependencies.store.getCluster(
          context.req.param('clusterId'),
        )
        context.header('ETag', etag(cluster.resourceVersion))
        context.header('Cache-Control', 'private, no-cache')
        return context.json(cluster)
      },
    ),
  )

  app.put('/api/clusters/:clusterId', async (context) => {
    const started = Date.now()
    const user = await verifyCatalogUser(context, dependencies)
    let status = 500
    try {
      requireUserScope(user, scopes.clustersWrite)
      const id = context.req.param('clusterId')
      validateClusterId(id)
      const input = normalizeClusterInput(await boundedJson(context.req.raw))
      const ifNoneMatch = context.req.header('If-None-Match')
      const cluster =
        ifNoneMatch === '*'
          ? await dependencies.store.createCluster(id, input)
          : await dependencies.store.replaceCluster(
              id,
              input,
              parseEtag(context.req.header('If-Match')),
            )
      await publishInventory(context, dependencies, cluster)
      context.header('ETag', etag(cluster.resourceVersion))
      if (ifNoneMatch === '*')
        context.header(
          'Location',
          `${dependencies.config.apiUrl}/clusters/${encodeURIComponent(id)}`,
        )
      const response = context.json(cluster, ifNoneMatch === '*' ? 201 : 200)
      status = response.status
      return response
    } catch (error) {
      status = auditStatus(error, status)
      throw error
    } finally {
      await appendCatalogAudit(
        context,
        dependencies,
        user,
        context.req.param('clusterId'),
        status,
        started,
      )
    }
  })

  app.delete('/api/clusters/:clusterId', async (context) => {
    const started = Date.now()
    const user = await verifyCatalogUser(context, dependencies)
    let status = 500
    try {
      requireUserScope(user, scopes.clustersWrite)
      const id = context.req.param('clusterId')
      await dependencies.store.deleteCluster(
        id,
        parseEtag(context.req.header('If-Match')),
      )
      await removeInventory(context, dependencies, id)
      const response = context.body(null, 204)
      status = response.status
      return response
    } catch (error) {
      status = auditStatus(error, status)
      throw error
    } finally {
      await appendCatalogAudit(
        context,
        dependencies,
        user,
        context.req.param('clusterId'),
        status,
        started,
      )
    }
  })

  app.get('/api/audit-events', (context) =>
    readForUserOrAgent(context, dependencies, scopes.auditRead, '', () => {
      return auditPage(
        context,
        dependencies.store,
        `${dependencies.config.apiUrl}/audit-events`,
      )
    }),
  )
}

async function publishInventory(
  context: Parameters<typeof verifyAgent>[0],
  dependencies: AppDependencies,
  cluster: Cluster,
): Promise<void> {
  if (!dependencies.inventory) {
    context.header('Inventory-Status', 'disabled')
    return
  }
  try {
    await dependencies.inventory.publish(cluster)
    context.header('Inventory-Status', 'synchronized')
  } catch (error) {
    context.header('Inventory-Status', 'pending')
    logInventoryFailure(context, 'publish', cluster.id, error)
  }
}

async function removeInventory(
  context: Parameters<typeof verifyAgent>[0],
  dependencies: AppDependencies,
  clusterId: string,
): Promise<void> {
  if (!dependencies.inventory) {
    context.header('Inventory-Status', 'disabled')
    return
  }
  try {
    await dependencies.inventory.remove(clusterId)
    context.header('Inventory-Status', 'synchronized')
  } catch (error) {
    context.header('Inventory-Status', 'pending')
    logInventoryFailure(context, 'remove', clusterId, error)
  }
}

function logInventoryFailure(
  context: Parameters<typeof verifyAgent>[0],
  operation: 'publish' | 'remove',
  clusterId: string,
  error: unknown,
): void {
  console.error(
    JSON.stringify({
      message: 'inventory.projection.pending',
      requestId: context.get('requestId'),
      operation,
      clusterId,
      error: error instanceof Error ? error.message : String(error),
    }),
  )
}

function appendCatalogAudit(
  context: Parameters<typeof verifyAgent>[0],
  dependencies: AppDependencies,
  user: UserPrincipal,
  clusterId: string,
  status: number,
  started: number,
): Promise<void> {
  return dependencies.store
    .appendAudit(
      auditForUser(context, user, clusterId, status, Date.now() - started),
    )
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          message: 'catalog.audit.error',
          requestId: context.get('requestId'),
          clusterId,
          status,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    })
}

async function readForUserOrAgent(
  context: Parameters<typeof verifyAgent>[0],
  dependencies: AppDependencies,
  scope: string,
  clusterId: string,
  read: (principal: UserPrincipal | AgentPrincipal) => Promise<Response>,
): Promise<Response> {
  const started = Date.now()
  const authorization = context.req.header('Authorization') || ''
  const principal = authorization.startsWith('DPoP ')
    ? await verifyAgent(context, dependencies)
    : await verifyCatalogUser(context, dependencies)
  let status = 403
  try {
    if (principal.type === 'agent') requireAgentScope(principal, scope)
    else requireUserScope(principal, scope)
    const response = await read(principal)
    status = response.status
    return response
  } catch (error) {
    status = auditStatus(error, status)
    throw error
  } finally {
    if (principal.type === 'agent') {
      try {
        await dependencies.store.appendAudit(
          auditForAgent(
            context,
            principal,
            clusterId,
            status,
            Date.now() - started,
          ),
        )
      } catch (error) {
        console.error(
          JSON.stringify({
            message: 'catalog.audit.error',
            requestId: context.get('requestId'),
            clusterId,
            status,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      }
    }
  }
}

function verifyCatalogUser(
  context: Parameters<typeof verifyAgent>[0],
  dependencies: AppDependencies,
): Promise<UserPrincipal> {
  return dependencies.catalogUsers.verify(context.req.header('Authorization'))
}
