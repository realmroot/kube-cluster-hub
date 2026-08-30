import { useQuery } from '@tanstack/react-query'
import { Activity, Bot, CircleOff, UserRound } from 'lucide-react'
import { useState } from 'react'
import type { HubApi } from '../../shared/api'
import { PaginationControls } from '../../shared/pagination-controls'

export function AuditPage({ api }: { api: HubApi }) {
  const [pageTokens, setPageTokens] = useState([''])
  const pageToken = pageTokens.at(-1) ?? ''
  const query = useQuery({
    queryKey: ['audit-events', pageToken],
    queryFn: () => api.listAuditEvents(pageToken),
  })
  const rows = query.data?.items ?? []
  return (
    <>
      <section className="page-heading">
        <div>
          <span className="eyebrow">Accountability</span>
          <h1>Access audit</h1>
          <p>
            User and agent requests recorded at the Kubernetes access boundary.
          </p>
        </div>
      </section>
      {query.isPending ? (
        <div className="table-card skeleton">
          <div />
          <div />
          <div />
        </div>
      ) : query.isError ? (
        <section className="state-card">
          <CircleOff />
          <h2>Could not load audit events</h2>
          <p>{query.error.message}</p>
        </section>
      ) : rows.length === 0 ? (
        <section className="state-card">
          <Activity />
          <h2>No access recorded</h2>
          <p>
            Events appear after a dashboard user or agent accesses a cluster.
          </p>
        </section>
      ) : (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>Actor</th>
                <th>Cluster</th>
                <th>Request</th>
                <th>Exchange</th>
                <th>Result</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <span className="cell-main">
                      {row.principalType === 'agent' ? (
                        <Bot size={16} />
                      ) : (
                        <UserRound size={16} />
                      )}
                      <b>
                        {row.agentSubject ||
                          row.userSubject ||
                          row.controllerSubject}
                      </b>
                    </span>
                    <small>{row.principalType}</small>
                  </td>
                  <td>{row.clusterId || 'Catalog'}</td>
                  <td>
                    <code>{row.method}</code>{' '}
                    <span className="truncate">{row.path}</span>
                  </td>
                  <td>
                    {row.principalType === 'agent' ? (
                      <>
                        <span
                          className={`badge ${row.exchangeStatus === 'succeeded' ? 'success' : 'error'}`}
                        >
                          {row.exchangeStatus}
                        </span>
                        <small className="truncate">{row.targetAudience}</small>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    <span
                      className={`badge ${row.status < 400 ? 'success' : 'error'}`}
                    >
                      {row.status}
                    </span>
                    <small>{row.durationMillis} ms</small>
                  </td>
                  <td>
                    <time dateTime={row.createdAt}>
                      {new Intl.DateTimeFormat(undefined, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }).format(new Date(row.createdAt))}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <PaginationControls
            page={pageTokens.length}
            hasNext={!!query.data?.pagination.nextPageToken}
            previous={() => setPageTokens((tokens) => tokens.slice(0, -1))}
            next={() => {
              const token = query.data?.pagination.nextPageToken
              if (token) setPageTokens((tokens) => [...tokens, token])
            }}
          />
        </div>
      )}
    </>
  )
}
