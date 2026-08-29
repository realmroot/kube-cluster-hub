import { X } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import type { Cluster, ClusterInput } from '../../shared/contracts'

const blank: ClusterInput = {
  displayName: '',
  description: '',
  apiServerUrl: '',
  prometheusUrl: '',
  enabled: true,
  default: false,
}

export function ClusterDialog({
  cluster,
  open,
  saving,
  error,
  onClose,
  onSave,
}: {
  cluster: Cluster | null
  open: boolean
  saving: boolean
  error: string
  onClose(): void
  onSave(id: string, input: ClusterInput): void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [id, setId] = useState('')
  const [value, setValue] = useState(blank)
  useEffect(() => {
    if (open) {
      setId(cluster?.id ?? '')
      setValue(
        cluster
          ? {
              displayName: cluster.displayName,
              description: cluster.description,
              apiServerUrl: cluster.apiServerUrl,
              prometheusUrl: cluster.prometheusUrl,
              enabled: cluster.enabled,
              default: cluster.default,
            }
          : blank,
      )
      if (typeof dialog.current?.showModal === 'function')
        dialog.current.showModal()
    } else if (typeof dialog.current?.close === 'function')
      dialog.current.close()
  }, [cluster, open])
  const update = <K extends keyof ClusterInput>(
    name: K,
    next: ClusterInput[K],
  ) => setValue((current) => ({ ...current, [name]: next }))
  function submit(event: FormEvent) {
    event.preventDefault()
    onSave(id, value)
  }
  return (
    <dialog
      ref={dialog}
      className="dialog"
      onCancel={onClose}
      onClose={onClose}
      aria-labelledby="cluster-dialog-title"
    >
      <form onSubmit={submit} className="dialog-card">
        <header className="dialog-header">
          <div>
            <span className="eyebrow">Cluster catalog</span>
            <h2 id="cluster-dialog-title">
              {cluster ? 'Edit cluster' : 'Add cluster'}
            </h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>
        <div className="form-grid">
          <label>
            Cluster ID
            <input
              required
              disabled={!!cluster}
              pattern="[a-z0-9]([-a-z0-9]*[a-z0-9])?"
              maxLength={63}
              value={id}
              onChange={(event) => setId(event.target.value)}
              placeholder="production-east"
            />
            <small>Stable DNS label used in API paths.</small>
          </label>
          <label>
            Display name
            <input
              required
              maxLength={200}
              value={value.displayName}
              onChange={(event) => update('displayName', event.target.value)}
              placeholder="Production East"
            />
          </label>
          <label className="span-2">
            Description
            <textarea
              rows={3}
              value={value.description}
              onChange={(event) => update('description', event.target.value)}
              placeholder="Purpose, owner, or environment"
            />
          </label>
          <label className="span-2">
            Kubernetes API server
            <input
              required
              type="url"
              value={value.apiServerUrl}
              onChange={(event) => update('apiServerUrl', event.target.value)}
              placeholder="https://api.example.com:6443"
            />
            <small>
              Use an endpoint reachable by this Hub deployment through your
              existing network infrastructure.
            </small>
          </label>
          <label className="span-2">
            Prometheus URL <span className="optional">Optional</span>
            <input
              type="url"
              value={value.prometheusUrl}
              onChange={(event) => update('prometheusUrl', event.target.value)}
              placeholder="https://prometheus.example.com"
            />
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={value.enabled}
              onChange={(event) => update('enabled', event.target.checked)}
            />
            <span>Enable cluster</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={value.default}
              onChange={(event) => update('default', event.target.checked)}
            />
            <span>Set as default</span>
          </label>
        </div>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <footer className="dialog-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={saving}>
            {saving ? 'Saving…' : cluster ? 'Save changes' : 'Add cluster'}
          </button>
        </footer>
      </form>
    </dialog>
  )
}
