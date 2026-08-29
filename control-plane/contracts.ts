import type { Config } from './config'

export const apiVersion = '2026-08-29'
export const scopes = {
  clustersRead: 'clusters:read',
  clustersWrite: 'clusters:write',
  kubernetesRead: 'kubernetes:read',
  kubernetesWrite: 'kubernetes:write',
  auditRead: 'audit-events:read',
} as const

export const hubScopes = [
  scopes.clustersRead,
  scopes.clustersWrite,
  scopes.kubernetesRead,
  scopes.kubernetesWrite,
  scopes.auditRead,
] as const

export function kubernetesScope(method: string, uri: string): string {
  const pathname = uri.split('?', 1)[0] || '/'
  const mutatingSubresource = /\/(exec|attach|portforward)$/.test(pathname)
  return ['GET', 'HEAD', 'OPTIONS'].includes(method) && !mutatingSubresource
    ? scopes.kubernetesRead
    : scopes.kubernetesWrite
}

const problem = {
  type: 'object',
  required: ['type', 'title', 'status', 'detail'],
  properties: {
    type: { type: 'string', format: 'uri-reference' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    requestId: { type: 'string' },
  },
}

const cluster = {
  type: 'object',
  required: [
    'id',
    'displayName',
    'apiServerUrl',
    'enabled',
    'default',
    'resourceVersion',
  ],
  properties: {
    id: { type: 'string' },
    displayName: { type: 'string' },
    description: { type: 'string' },
    apiServerUrl: {
      type: 'string',
      format: 'uri',
      description: 'Kubernetes API endpoint reachable by the Hub runtime',
    },
    prometheusUrl: { type: 'string', format: 'uri' },
    enabled: { type: 'boolean' },
    default: { type: 'boolean' },
    resourceVersion: { type: 'integer', minimum: 1 },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
}

const clusterInput = {
  type: 'object',
  additionalProperties: false,
  required: ['displayName', 'apiServerUrl', 'enabled', 'default'],
  properties: {
    displayName: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    apiServerUrl: { type: 'string', format: 'uri' },
    prometheusUrl: { type: 'string', format: 'uri' },
    enabled: { type: 'boolean' },
    default: { type: 'boolean' },
  },
}

const auditEvent = {
  type: 'object',
  required: [
    'id',
    'createdAt',
    'requestId',
    'principalType',
    'clusterId',
    'method',
    'path',
    'status',
    'durationMillis',
  ],
  properties: {
    id: { type: 'integer', minimum: 1 },
    createdAt: { type: 'string', format: 'date-time' },
    requestId: { type: 'string' },
    tokenId: { type: 'string' },
    principalType: { type: 'string', enum: ['user', 'agent'] },
    controllerSubject: { type: 'string' },
    agentIssuer: { type: 'string' },
    agentSubject: { type: 'string' },
    userSubject: { type: 'string' },
    clientId: { type: 'string' },
    scopes: { type: 'string' },
    clusterId: { type: 'string' },
    method: { type: 'string' },
    path: { type: 'string' },
    status: { type: 'integer', minimum: 100, maximum: 599 },
    durationMillis: { type: 'integer', minimum: 0 },
  },
}

export function hubOpenApi(config: Config): object {
  const userSecurity = (scope: string) => [{ userOAuth: [scope] }]
  const agentSecurity = (scope: string) => [{ agentOAuth: [scope] }]
  const userOrAgentSecurity = (scope: string) => [
    ...userSecurity(scope),
    ...agentSecurity(scope),
  ]
  return {
    openapi: '3.1.0',
    info: {
      title: 'Kube Cluster Hub API',
      version: apiVersion,
      description:
        'Manage the cluster catalog and invoke Kubernetes through one Realmroot Resource Server. Browser users use Bearer access tokens for catalog operations. Agents use DPoP-bound access tokens and preserve their actor identity at the audit boundary.',
    },
    servers: [{ url: config.apiUrl }],
    components: {
      securitySchemes: {
        userOAuth: {
          type: 'openIdConnect',
          openIdConnectUrl: `${config.oidcIssuer}/.well-known/openid-configuration`,
        },
        agentOAuth: {
          type: 'openIdConnect',
          openIdConnectUrl: `${config.oidcIssuer}/.well-known/openid-configuration`,
          'x-dpop-required': true,
        },
      },
      parameters: {
        apiVersion: {
          name: 'API-Version',
          in: 'header',
          required: true,
          schema: { type: 'string', enum: [apiVersion] },
        },
        requestId: {
          name: 'Request-Id',
          in: 'header',
          required: false,
          schema: { type: 'string' },
        },
        pageSize: {
          name: 'pageSize',
          in: 'query',
          schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
        pageToken: {
          name: 'pageToken',
          in: 'query',
          schema: { type: 'string' },
        },
      },
      schemas: {
        Cluster: cluster,
        ClusterInput: clusterInput,
        AuditEvent: auditEvent,
        Problem: problem,
      },
    },
    paths: {
      '/clusters': {
        get: operation(
          'listClusters',
          'List clusters',
          [
            parameter('apiVersion'),
            parameter('pageSize'),
            parameter('pageToken'),
          ],
          false,
          userOrAgentSecurity(scopes.clustersRead),
        ),
      },
      '/clusters/{clusterId}': {
        parameters: [
          {
            name: 'clusterId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        get: operation(
          'getCluster',
          'Get a cluster',
          [parameter('apiVersion')],
          false,
          userOrAgentSecurity(scopes.clustersRead),
        ),
        put: operation(
          'replaceCluster',
          'Create or replace a cluster',
          [parameter('apiVersion')],
          true,
          userSecurity(scopes.clustersWrite),
        ),
        delete: operation(
          'deleteCluster',
          'Delete a cluster',
          [parameter('apiVersion')],
          false,
          userSecurity(scopes.clustersWrite),
        ),
      },
      '/audit-events': {
        get: operation(
          'listAuditEvents',
          'List immutable access audit events',
          [
            parameter('apiVersion'),
            parameter('pageSize'),
            parameter('pageToken'),
          ],
          false,
          userOrAgentSecurity(scopes.auditRead),
        ),
      },
      '/clusters/{clusterId}/kubernetes': {
        parameters: [
          {
            name: 'clusterId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        get: kubernetesOperation(
          'getKubernetesApiRoot',
          agentSecurity(scopes.kubernetesRead),
        ),
      },
      '/clusters/{clusterId}/kubernetes/{kubernetesPath}': {
        parameters: [
          {
            name: 'clusterId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
          {
            name: 'kubernetesPath',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        get: kubernetesOperation(
          'getKubernetesResource',
          agentSecurity(scopes.kubernetesRead),
        ),
        post: kubernetesOperation(
          'createKubernetesResource',
          agentSecurity(scopes.kubernetesWrite),
          true,
        ),
        put: kubernetesOperation(
          'replaceKubernetesResource',
          agentSecurity(scopes.kubernetesWrite),
          true,
        ),
        patch: kubernetesOperation(
          'updateKubernetesResource',
          agentSecurity(scopes.kubernetesWrite),
          true,
        ),
        delete: kubernetesOperation(
          'deleteKubernetesResource',
          agentSecurity(scopes.kubernetesWrite),
        ),
      },
    },
  }
}

function parameter(name: string): object {
  return { $ref: `#/components/parameters/${name}` }
}

function operation(
  operationId: string,
  summary: string,
  parameters: object[] = [],
  body = false,
  security?: object[],
): object {
  return {
    operationId,
    summary,
    ...(security ? { security } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(body
      ? {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ClusterInput' },
              },
            },
          },
        }
      : {}),
    responses: {
      '200': { description: 'Success' },
      '400': { description: 'Invalid request' },
      '401': { description: 'Authentication required' },
      '403': { description: 'Forbidden' },
      '412': { description: 'Precondition failed' },
    },
  }
}

function kubernetesOperation(
  operationId: string,
  security: object[],
  body = false,
): object {
  return {
    operationId,
    summary: 'Invoke the Kubernetes API',
    security,
    parameters: [parameter('apiVersion'), ...kubernetesQueryParameters()],
    ...(body
      ? {
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: {} },
              'application/yaml': { schema: { type: 'string' } },
              'application/merge-patch+json': { schema: {} },
              'application/json-patch+json': { schema: {} },
            },
          },
        }
      : {}),
    responses: {
      '200': { description: 'Kubernetes response' },
      default: { description: 'Kubernetes response or gateway problem' },
    },
  }
}

function kubernetesQueryParameters(): object[] {
  const query = (name: string, schema: object) => ({
    name,
    in: 'query',
    required: false,
    schema,
  })
  return [
    query('labelSelector', { type: 'string' }),
    query('fieldSelector', { type: 'string' }),
    query('limit', { type: 'integer', minimum: 1 }),
    query('continue', { type: 'string' }),
    query('resourceVersion', { type: 'string' }),
    query('resourceVersionMatch', {
      type: 'string',
      enum: ['Exact', 'NotOlderThan'],
    }),
    query('watch', { type: 'boolean' }),
    query('allowWatchBookmarks', { type: 'boolean' }),
    query('sendInitialEvents', { type: 'boolean' }),
    query('timeoutSeconds', { type: 'integer', minimum: 1 }),
    query('container', { type: 'string' }),
    query('follow', { type: 'boolean' }),
    query('previous', { type: 'boolean' }),
    query('sinceSeconds', { type: 'integer', minimum: 1 }),
    query('tailLines', { type: 'integer', minimum: 0 }),
    query('timestamps', { type: 'boolean' }),
    query('pretty', { type: 'string' }),
    query('dryRun', { type: 'string' }),
    query('fieldManager', { type: 'string' }),
    query('fieldValidation', {
      type: 'string',
      enum: ['Ignore', 'Warn', 'Strict'],
    }),
    query('force', { type: 'boolean' }),
    query('gracePeriodSeconds', { type: 'integer', minimum: 0 }),
    query('propagationPolicy', {
      type: 'string',
      enum: ['Orphan', 'Background', 'Foreground'],
    }),
  ]
}
