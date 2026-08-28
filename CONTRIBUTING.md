# Contributing

Thank you for helping improve Kube Cluster Hub. The project deliberately keeps a narrow scope: a Kubernetes-native cluster catalog and access boundary for dashboards, operators, and authorized agents.

## Before opening a change

- Use an issue for new public APIs, security-boundary changes, persistence migrations, or substantial UI behavior.
- Keep browser-user and Agent execution paths separate.
- Never add kubeconfigs, long-lived Kubernetes credentials, or a second resource authorization model.
- Prefer upstream Kubernetes APIs and conventions over product-specific abstractions.

## Development

Requirements are Node.js 24+, pnpm 10+, Go 1.26+, and optionally Docker and kind.

```sh
cp .env.example .env
make deps
make run
```

Run the complete local quality gate before submitting:

```sh
make verify
```

Public API changes require tests and an OpenAPI update. Persistence changes require a forward-only migration. UI changes must include loading, empty, error, and unauthorized states and remain keyboard accessible.

## Pull requests

Use focused commits and explain the motivation, security impact, verification performed, and any migration or compatibility effect. By contributing, you agree that your contribution is licensed under Apache-2.0.
