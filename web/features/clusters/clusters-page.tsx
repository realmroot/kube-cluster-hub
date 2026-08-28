import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Cable,
  CircleCheck,
  CircleOff,
  MoreHorizontal,
  Plus,
  Server,
  Trash2,
} from 'lucide-react'
import { useState } from 'react'
import type { HubApi } from '../../shared/api'
import type { Cluster, ClusterInput } from '../../shared/contracts'
import { ClusterDialog } from './cluster-dialog'

export function ClustersPage({ api }: { api: HubApi }) {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ['clusters'],
    queryFn: () => api.listClusters(),
  })
  const [editing, setEditing] = useState<Cluster | null | undefined>(undefined)
  const [deleteTarget, setDeleteTarget] = useState<Cluster | null>(null)
  const save = useMutation({
    mutationFn: ({ id, input }: { id: string; input: ClusterInput }) =>
      api.saveCluster(id, input, editing?.resourceVersion),
    onSuccess: async () => {
      setEditing(undefined)
      await client.invalidateQueries({ queryKey: ['clusters'] })
    },
  })
  const remove = useMutation({
    mutationFn: (cluster: Cluster) => api.deleteCluster(cluster),
    onSuccess: async () => {
      setDeleteTarget(null)
      await client.invalidateQueries({ queryKey: ['clusters'] })
    },
  })
  const clusters = query.data?.items ?? []
  return (
    <>
      <section className="page-heading">
        <div>
          <span className="eyebrow">Infrastructure</span>
          <h1>Clusters</h1>
          <p>One catalog for dashboards, operators, and authorized agents.</p>
        </div>
        <button
          type="button"
          className="button primary"
          onClick={() => setEditing(null)}
        >
          <Plus size={17} /> Add cluster
        </button>
      </section>
      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <ErrorState
          message={query.error.message}
          retry={() => query.refetch()}
        />
      ) : clusters.length === 0 ? (
        <EmptyState add={() => setEditing(null)} />
      ) : (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>Cluster</th>
                <th>Connection</th>
                <th>Status</th>
                <th>Updated</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {clusters.map((cluster) => (
                <tr key={cluster.id}>
                  <td>
                    <button
                      type="button"
                      className="cluster-name"
                      onClick={() => setEditing(cluster)}
                    >
                      <span className="resource-icon">
                        <Server size={17} />
                      </span>
                      <span>
                        <b>{cluster.displayName}</b>
                        <small>
                          {cluster.id}
                          {cluster.default ? ' · Default' : ''}
                        </small>
                      </span>
                    </button>
                  </td>
                  <td>
                    <span className="cell-main">
                      <Cable size={15} />
                      Kubernetes API
                    </span>
                    <small className="truncate">{cluster.apiServerUrl}</small>
                  </td>
                  <td>
                    {cluster.enabled ? (
                      <span className="status enabled">
                        <CircleCheck size={15} />
                        Enabled
                      </span>
                    ) : (
                      <span className="status">
                        <CircleOff size={15} />
                        Disabled
                      </span>
                    )}
                  </td>
                  <td>
                    <time dateTime={cluster.updatedAt}>
                      {new Intl.DateTimeFormat(undefined, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }).format(new Date(cluster.updatedAt))}
                    </time>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Edit ${cluster.displayName}`}
                        onClick={() => setEditing(cluster)}
                      >
                        <MoreHorizontal size={18} />
                      </button>
                      <button
                        type="button"
                        className="icon-button danger"
                        aria-label={`Delete ${cluster.displayName}`}
                        onClick={() => setDeleteTarget(cluster)}
                      >
                        <Trash2 size={17} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ClusterDialog
        cluster={editing ?? null}
        open={editing !== undefined}
        saving={save.isPending}
        error={save.error?.message ?? ''}
        onClose={() => {
          setEditing(undefined)
          save.reset()
        }}
        onSave={(id, input) => save.mutate({ id, input })}
      />
      {deleteTarget && (
        <div className="alert-overlay" role="presentation">
          <section
            className="confirm-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-title"
          >
            <h2 id="delete-title">Delete {deleteTarget.displayName}?</h2>
            <p>
              This removes the catalog entry. It does not delete the Kubernetes
              cluster.
            </p>
            {remove.error && (
              <div className="form-error">{remove.error.message}</div>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setDeleteTarget(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button destructive"
                disabled={remove.isPending}
                onClick={() => remove.mutate(deleteTarget)}
              >
                {remove.isPending ? 'Deleting…' : 'Delete cluster'}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  )
}

function TableSkeleton() {
  return (
    <div
      className="table-card skeleton"
      role="status"
      aria-label="Loading clusters"
    >
      <div />
      <div />
      <div />
      <div />
    </div>
  )
}
function ErrorState({ message, retry }: { message: string; retry(): void }) {
  return (
    <section className="state-card">
      <CircleOff size={28} />
      <h2>Could not load clusters</h2>
      <p>{message}</p>
      <button type="button" className="button secondary" onClick={retry}>
        Try again
      </button>
    </section>
  )
}
function EmptyState({ add }: { add(): void }) {
  return (
    <section className="state-card">
      <Server size={30} />
      <h2>No clusters yet</h2>
      <p>
        Add a Kubernetes API endpoint reachable through your public or private
        network.
      </p>
      <button type="button" className="button primary" onClick={add}>
        <Plus size={17} />
        Add your first cluster
      </button>
    </section>
  )
}
