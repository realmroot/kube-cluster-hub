import type { AppDependencies, HubApp } from '../app-dependencies'
import { scopes } from '../contracts'
import type { AgentPrincipal, UserPrincipal } from '../domain'
import { normalizeClusterInput, validateClusterId } from '../domain'
import {
  auditStatus,
  boundedJson,
  catalogVersion,
  etag,
  parseEtag,
  requireAdmin,
  requireAgentScope,
  requireUserScope,
} from '../http'
import { InventoryPublicationError } from '../inventory'
import { auditForAgent, verifyAgent } from './access'
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
        return context.json(cluster)
      },
    ),
  )

  app.put('/api/clusters/:clusterId', async (context) => {
    const user = await verifyCatalogUser(context, dependencies)
    requireUserScope(user, scopes.clustersWrite)
    requireAdmin(user, dependencies.config)
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
    try {
      await dependencies.inventory?.publish(cluster)
    } catch (error) {
      throw new InventoryPublicationError(error)
    }
    context.header('ETag', etag(cluster.resourceVersion))
    return context.json(cluster, ifNoneMatch === '*' ? 201 : 200)
  })

  app.delete('/api/clusters/:clusterId', async (context) => {
    const user = await verifyCatalogUser(context, dependencies)
    requireUserScope(user, scopes.clustersWrite)
    requireAdmin(user, dependencies.config)
    const id = context.req.param('clusterId')
    await dependencies.store.deleteCluster(
      id,
      parseEtag(context.req.header('If-Match')),
    )
    try {
      await dependencies.inventory?.remove(id)
    } catch (error) {
      throw new InventoryPublicationError(error)
    }
    return context.body(null, 204)
  })

  app.get('/api/audit-events', (context) =>
    readForUserOrAgent(
      context,
      dependencies,
      scopes.auditRead,
      '',
      (principal) => {
        if (principal.type === 'user')
          requireAdmin(principal, dependencies.config)
        return auditPage(
          context,
          dependencies.store,
          `${dependencies.config.apiUrl}/audit-events`,
        )
      },
    ),
  )
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
    if (principal.type === 'agent')
      await dependencies.store.appendAudit(
        auditForAgent(
          context,
          principal,
          clusterId,
          status,
          Date.now() - started,
        ),
      )
  }
}

function verifyCatalogUser(
  context: Parameters<typeof verifyAgent>[0],
  dependencies: AppDependencies,
): Promise<UserPrincipal> {
  return dependencies.catalogUsers.verify(context.req.header('Authorization'))
}
