.PHONY: deps run run-node run-connector test test-worker test-e2e test-race build build-control-plane build-connector build-worker verify image-control-plane image-connector install-crd deploy

-include .env
export

deps:
	pnpm install --frozen-lockfile
	go mod download

run:
	pnpm dev

run-node:
	pnpm dev:node

run-connector:
	go run ./cmd/kube-cluster-connector

test:
	pnpm test
	go test ./internal/connector ./cmd/kube-cluster-connector

test-worker:
	pnpm test:worker

test-e2e:
	pnpm test:e2e

test-race:
	go test -race ./internal/connector ./cmd/kube-cluster-connector

build: build-control-plane build-connector build-worker

build-control-plane:
	pnpm build
	pnpm build:node

build-connector:
	go build ./cmd/kube-cluster-connector

build-worker:
	pnpm build:worker

verify:
	pnpm exec biome check .
	pnpm typecheck
	pnpm test
	pnpm test:worker
	go vet ./internal/connector ./cmd/kube-cluster-connector
	go test -race ./internal/connector ./cmd/kube-cluster-connector
	$(MAKE) build

image-control-plane:
	docker build -t kube-cluster-hub:dev .

image-connector:
	docker build -f Dockerfile.connector -t kube-cluster-connector:dev .

install-crd:
	kubectl apply -f https://raw.githubusercontent.com/kubernetes-sigs/cluster-inventory-api/v0.1.3/config/crd/bases/multicluster.x-k8s.io_clusterprofiles.yaml

deploy: image-control-plane image-connector install-crd
	kind load docker-image kube-cluster-hub:dev kube-cluster-connector:dev --name kite-realmroot-demo
	kubectl apply -f deploy/control-plane.yaml
	kubectl apply -f deploy/connector.yaml
	kubectl apply -f deploy/agent-rbac-example.yaml
