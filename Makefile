.PHONY: deps run run-node test test-worker test-e2e build build-node build-worker verify verify-image image deploy-kind

KIND_CLUSTER ?= kind

-include .env
export

deps:
	pnpm install --frozen-lockfile

run:
	pnpm dev

run-node:
	pnpm dev:node

test:
	pnpm test

test-worker:
	pnpm test:worker

test-e2e:
	pnpm test:e2e

build: build-node build-worker

build-node:
	pnpm build
	pnpm build:node

build-worker:
	pnpm build:worker

verify:
	pnpm exec biome check .
	pnpm lint:dead-code
	pnpm check:openapi
	pnpm check:security
	pnpm check:worker-types
	pnpm typecheck
	pnpm test
	pnpm test:worker
	$(MAKE) build
	pnpm check:deploy

image:
	docker build -t kube-cluster-hub:dev .

verify-image:
	pnpm check:image

deploy-kind: image
	kind load docker-image kube-cluster-hub:dev --name $(KIND_CLUSTER)
	kubectl apply -f deploy/control-plane.yaml
