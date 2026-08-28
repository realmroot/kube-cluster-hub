.PHONY: deps run test test-race build verify image install-crd deploy

-include .env
export

deps:
	go mod download

run:
	go run ./cmd/cluster-access-gateway

test:
	go test ./...

test-race:
	go test -race ./...

build:
	go build ./cmd/cluster-access-gateway

verify: test-race build

image:
	docker build -t cluster-access-gateway:dev .

install-crd:
	kubectl apply -f https://raw.githubusercontent.com/kubernetes-sigs/cluster-inventory-api/v0.1.3/config/crd/bases/multicluster.x-k8s.io_clusterprofiles.yaml

deploy: image install-crd
	kind load docker-image cluster-access-gateway:dev --name kite-realmroot-demo
	kubectl apply -f deploy/gateway.yaml
	kubectl apply -f deploy/agent-rbac-example.yaml
