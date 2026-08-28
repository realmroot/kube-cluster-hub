.PHONY: deps run run-connector test test-race build build-control-plane build-connector build-worker verify image-control-plane image-connector install-crd deploy

-include .env
export

deps:
	pnpm install --frozen-lockfile
	go mod download

run:
	pnpm dev

run-connector:
	go run ./cmd/cluster-access-connector

test:
	pnpm test
	go test ./internal/connector ./cmd/cluster-access-connector

test-race:
	go test -race ./internal/connector ./cmd/cluster-access-connector

build: build-control-plane build-connector build-worker

build-control-plane:
	pnpm build

build-connector:
	go build ./cmd/cluster-access-connector

build-worker:
	pnpm build:worker

verify:
	pnpm exec biome check control-plane
	pnpm typecheck
	pnpm test
	go vet ./internal/connector ./cmd/cluster-access-connector
	go test -race ./internal/connector ./cmd/cluster-access-connector
	$(MAKE) build

image-control-plane:
	docker build -t cluster-access-control-plane:dev .

image-connector:
	docker build -f Dockerfile.connector -t cluster-access-connector:dev .

install-crd:
	kubectl apply -f https://raw.githubusercontent.com/kubernetes-sigs/cluster-inventory-api/v0.1.3/config/crd/bases/multicluster.x-k8s.io_clusterprofiles.yaml

deploy: image-control-plane image-connector install-crd
	kind load docker-image cluster-access-control-plane:dev cluster-access-connector:dev --name kite-realmroot-demo
	kubectl apply -f deploy/control-plane.yaml
	kubectl apply -f deploy/connector.yaml
	kubectl apply -f deploy/agent-rbac-example.yaml
