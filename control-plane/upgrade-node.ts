import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Duplex } from 'node:stream'
import { AuthenticationError } from './auth'
import type { Runtime } from './bootstrap'
import { kubernetesScope } from './contracts'
import { sanitizedHeaders } from './dispatch'
import {
  type AgentPrincipal,
  type Cluster,
  NotFoundError,
  type UserPrincipal,
} from './domain'

interface PreparedUpgrade {
  target: string
  headers: Headers
  principal: UserPrincipal | AgentPrincipal
  clusterId: string
  requestId: string
}

export function attachNodeUpgradeHandler(
  server: import('node:http').Server,
  runtime: Runtime,
): void {
  server.on('upgrade', (request, socket, head) => {
    void handleUpgrade(request, socket, head, runtime)
  })
}

async function handleUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  runtime: Runtime,
): Promise<void> {
  const started = Date.now()
  let prepared: PreparedUpgrade | undefined
  try {
    prepared = await prepareUpgrade(request, runtime)
    const target = new URL(prepared.target)
    const makeRequest =
      target.protocol === 'https:' ? httpsRequest : httpRequest
    const upstream = makeRequest(target, {
      method: request.method,
      headers: Object.fromEntries(prepared.headers.entries()),
    })
    upstream.once('upgrade', (response, upstreamSocket, upstreamHead) => {
      writeResponseHead(socket, response, prepared?.requestId)
      if (head.length) upstreamSocket.write(head)
      if (upstreamHead.length) socket.write(upstreamHead)
      socket.pipe(upstreamSocket).pipe(socket)
      upstreamSocket.once('close', () => {
        void appendUpgradeAudit(runtime, prepared, request, 101, started)
      })
    })
    upstream.once('response', (response) => {
      writeResponseHead(socket, response, prepared?.requestId)
      response.pipe(socket)
      response.once('end', () => {
        void appendUpgradeAudit(
          runtime,
          prepared,
          request,
          response.statusCode ?? 502,
          started,
        )
      })
    })
    upstream.once('error', (error) => {
      writeProblem(socket, 502, 'Upstream unavailable', prepared?.requestId)
      void appendUpgradeAudit(runtime, prepared, request, 502, started)
      console.error(
        JSON.stringify({
          message: 'upgrade.upstream.error',
          error: error.message,
        }),
      )
    })
    upstream.end()
  } catch (error) {
    const status = upgradeErrorStatus(error)
    writeProblem(
      socket,
      status,
      error instanceof Error ? error.message : 'Upgrade failed',
      prepared?.requestId,
    )
    if (prepared)
      await appendUpgradeAudit(runtime, prepared, request, status, started)
  }
}

async function prepareUpgrade(
  request: IncomingMessage,
  runtime: Runtime,
): Promise<PreparedUpgrade> {
  const method = request.method || 'GET'
  const url = new URL(request.url || '/', runtime.config.publicUrl)
  const requestId = crypto.randomUUID()
  const headers = sanitizedHeaders(headersFromIncoming(request))
  const agentMatch =
    /^\/api\/agent\/clusters\/([^/]+)\/kubernetes(\/.*)?$/.exec(url.pathname)
  const userMatch = /^\/clusters\/([^/]+)\/kubernetes(\/.*)?$/.exec(
    url.pathname,
  )
  if (!agentMatch && !userMatch)
    throw new UpgradeRequestError(404, 'Upgrade route was not found')
  const match = agentMatch || userMatch
  const clusterId = decodeURIComponent(match?.[1] || '')
  const uri = `${match?.[2] || '/'}${url.search}`
  let principal: UserPrincipal | AgentPrincipal
  if (agentMatch) {
    const canonical = `${runtime.config.resourceUrl}${url.pathname.slice('/api/agent'.length)}${url.search}`
    principal = await runtime.dependencies.agents.verify(
      request.headers.authorization,
      header(request, 'dpop'),
      method,
      canonical,
    )
    const requiredScope = kubernetesScope(method, uri)
    if (!principal.scopes.includes(requiredScope))
      throw new UpgradeRequestError(403, `${requiredScope} is required`)
  } else {
    principal = await runtime.dependencies.users.verify(
      request.headers.authorization,
    )
  }

  const cluster = await runtime.store.getCluster(clusterId)
  if (!cluster.enabled)
    throw new UpgradeRequestError(503, 'cluster is disabled')
  if (principal.type === 'agent') {
    if (cluster.accessMode !== 'connector')
      throw new UpgradeRequestError(503, 'Agent access requires connector mode')
    const dispatch = await runtime.dependencies.proxy.signer.forAgent(
      clusterId,
      method,
      uri,
      requestId,
      principal,
    )
    headers.set('Authorization', `Bearer ${dispatch}`)
    return {
      target: connectorTarget(cluster, uri),
      headers,
      principal,
      clusterId,
      requestId,
    }
  }

  if (cluster.accessMode === 'connector') {
    const dispatch = await runtime.dependencies.proxy.signer.forUser(
      clusterId,
      method,
      uri,
      requestId,
      principal,
    )
    headers.set('Authorization', `Bearer ${dispatch}`)
    headers.set('X-Cluster-Authorization', `Bearer ${principal.token}`)
    return {
      target: connectorTarget(cluster, uri),
      headers,
      principal,
      clusterId,
      requestId,
    }
  }
  headers.set('Authorization', `Bearer ${principal.token}`)
  return {
    target: `${cluster.apiServerUrl}${uri}`,
    headers,
    principal,
    clusterId,
    requestId,
  }
}

function connectorTarget(cluster: Cluster, uri: string): string {
  return `${cluster.connectorUrl}/clusters/${encodeURIComponent(cluster.id)}/kubernetes${uri}`
}

function headersFromIncoming(request: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value))
      for (const item of value) headers.append(name, item)
    else if (value !== undefined) headers.set(name, value)
  }
  return headers
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function writeResponseHead(
  socket: Duplex,
  response: IncomingMessage,
  requestId?: string,
): void {
  socket.write(
    `HTTP/1.1 ${response.statusCode || 502} ${response.statusMessage || ''}\r\n`,
  )
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    socket.write(
      `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`,
    )
  }
  if (requestId) socket.write(`Request-Id: ${requestId}\r\n`)
  socket.write('\r\n')
}

function writeProblem(
  socket: Duplex,
  status: number,
  detail: string,
  requestId?: string,
): void {
  if (socket.destroyed) return
  const body = JSON.stringify({
    type: 'about:blank',
    title: 'Upgrade failed',
    status,
    detail,
    requestId,
  })
  socket.end(
    `HTTP/1.1 ${status} Upgrade failed\r\nContent-Type: application/problem+json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  )
}

async function appendUpgradeAudit(
  runtime: Runtime,
  prepared: PreparedUpgrade | undefined,
  request: IncomingMessage,
  status: number,
  started: number,
): Promise<void> {
  if (!prepared) return
  const agent =
    prepared.principal.type === 'agent' ? prepared.principal : undefined
  const user =
    prepared.principal.type === 'user' ? prepared.principal : undefined
  await runtime.store.appendAudit({
    requestId: prepared.requestId,
    tokenId: agent?.tokenId || '',
    principalType: prepared.principal.type,
    controllerSubject: agent?.controllerSubject || '',
    agentIssuer: agent?.actor.issuer || '',
    agentSubject: agent?.actor.subject || '',
    userSubject: user?.subject || '',
    clientId: agent?.clientId || '',
    scopes: agent?.scope || '',
    clusterId: prepared.clusterId,
    method: request.method || 'GET',
    path: new URL(request.url || '/', runtime.config.publicUrl).pathname,
    status,
    durationMillis: Date.now() - started,
  })
}

class UpgradeRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function upgradeErrorStatus(error: unknown): number {
  if (error instanceof UpgradeRequestError) return error.status
  if (error instanceof NotFoundError) return 404
  if (error instanceof AuthenticationError) return 401
  return 500
}
