FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/cluster-access-gateway ./cmd/cluster-access-gateway

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=build /out/cluster-access-gateway /cluster-access-gateway
EXPOSE 8080
ENTRYPOINT ["/cluster-access-gateway"]

