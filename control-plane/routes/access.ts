import {
  ProxyError,
  proxyAgentRequest,
  proxyUserRequest,
} from '../../data-plane/proxy'
import type { AppDependencies, HubApp } from '../app-dependencies'
import { kubernetesScope, scopes } from '../contracts'
import type { AgentPrincipal, UserPrincipal } from '../domain'
import {
  auditStatus,
  type HubContext,
  requireAgentScope,
  requiredClusterId,
  requiredRequestId,
} from '../http'
import type { HubStore } from '../store'
import { auditPage, clusterPage } from './pages'

export function registerAccessRoutes(
  app: HubApp,
  dependencies: AppDependencies,
): void {
  app.all('/clusters/:clusterId/kubernetes', (context) =>
    userProxy(context, dependencies),
  )
  app.all('/clusters/:clusterId/kubernetes/*', (context) =>
    userProxy(context, dependencies),
  )

  app.get('/api/agent/clusters', async (context) => {
    const started = Date.now()
    const agent = await verifyAgent(context, dependencies)
    let status = 403
    try {
      requireAgentScope(agent, scopes.clustersRead)
      const response = await clusterPage(
        context,
        dependencies.store,
        `${dependencies.config.resourceUrl}/clusters`,
      )
      status = response.status
      return response
    } finally {
      await dependencies.store.appendAudit(
        auditForAgent(context, agent, '', status, Date.now() - started),
      )
    }
  })

  app.get('/api/agent/audit-events', async (context) => {
    const started = Date.now()
    const agent = await verifyAgent(context, dependencies)
    let status = 403
    try {
      requireAgentScope(agent, scopes.auditRead)
      const response = await auditPage(
        context,
        dependencies.store,
        `${dependencies.config.resourceUrl}/audit-events`,
      )
      status = response.status
      return response
    } finally {
      await dependencies.store.appendAudit(
        auditForAgent(context, agent, '', status, Date.now() - started),
      )
    }
  })

  app.all('/api/agent/clusters/:clusterId/kubernetes', (context) =>
    agentProxy(context, dependencies),
  )
  app.all('/api/agent/clusters/:clusterId/kubernetes/*', (context) =>
    agentProxy(context, dependencies),
  )
}

async function userProxy(
  context: HubContext,
  dependencies: AppDependencies,
): Promise<Response> {
  const started = Date.now()
  const user = await dependencies.kubernetesUsers.verify(
    context.req.header('Authorization'),
  )
  const clusterId = requiredClusterId(context)
  let status = 502
  try {
    const cluster = await enabledCluster(dependencies.store, clusterId)
    const response = await proxyUserRequest(
      context.req.raw,
      cluster,
      user,
      requiredRequestId(context),
      dependencies.proxy,
    )
    status = response.status
    return response
  } catch (error) {
    status = auditStatus(error, status)
    throw error
  } finally {
    await dependencies.store.appendAudit(
      auditForUser(context, user, clusterId, status, Date.now() - started),
    )
  }
}

async function agentProxy(
  context: HubContext,
  dependencies: AppDependencies,
): Promise<Response> {
  const started = Date.now()
  const agent = await verifyAgent(context, dependencies)
  const clusterId = requiredClusterId(context)
  let status = 403
  try {
    requireAgentScope(
      agent,
      kubernetesScope(context.req.method, new URL(context.req.url).pathname),
    )
    const cluster = await enabledCluster(dependencies.store, clusterId)
    status = 502
    const response = await proxyAgentRequest(
      context.req.raw,
      cluster,
      agent,
      requiredRequestId(context),
      dependencies.proxy,
    )
    status = response.status
    return response
  } catch (error) {
    status = auditStatus(error, status)
    throw error
  } finally {
    await dependencies.store.appendAudit(
      auditForAgent(context, agent, clusterId, status, Date.now() - started),
    )
  }
}

async function verifyAgent(
  context: HubContext,
  dependencies: AppDependencies,
): Promise<AgentPrincipal> {
  const url = new URL(context.req.url)
  const canonical = `${dependencies.config.resourceUrl}${url.pathname.slice('/api/agent'.length)}${url.search}`
  return dependencies.agents.verify(
    context.req.header('Authorization'),
    context.req.header('DPoP'),
    context.req.method,
    canonical,
  )
}

async function enabledCluster(store: HubStore, id: string) {
  const cluster = await store.getCluster(id)
  if (!cluster.enabled) throw new ProxyError('cluster is disabled', 503)
  return cluster
}

function auditForUser(
  context: HubContext,
  user: UserPrincipal,
  clusterId: string,
  status: number,
  durationMillis: number,
) {
  return {
    requestId: context.get('requestId'),
    tokenId: '',
    principalType: 'user' as const,
    controllerSubject: '',
    agentIssuer: '',
    agentSubject: '',
    userSubject: user.subject,
    clientId: '',
    scopes: '',
    clusterId,
    method: context.req.method,
    path: new URL(context.req.url).pathname,
    status,
    durationMillis,
  }
}

function auditForAgent(
  context: HubContext,
  agent: AgentPrincipal,
  clusterId: string,
  status: number,
  durationMillis: number,
) {
  return {
    requestId: context.get('requestId'),
    tokenId: agent.tokenId,
    principalType: 'agent' as const,
    controllerSubject: agent.controllerSubject,
    agentIssuer: agent.actor.issuer,
    agentSubject: agent.actor.subject,
    userSubject: '',
    clientId: agent.clientId,
    scopes: agent.scope,
    clusterId,
    method: context.req.method,
    path: new URL(context.req.url).pathname,
    status,
    durationMillis,
  }
}
