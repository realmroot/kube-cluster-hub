package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"github.com/realmroot/kube-cluster-hub/internal/connector"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	cfg, err := connector.LoadConfig()
	if err != nil {
		log.Fatal(err)
	}
	handler, err := connector.New(cfg)
	if err != nil {
		log.Fatal(err)
	}
	go handler.ReportStatus(ctx)

	server := &http.Server{
		Addr:              cfg.Address,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       90 * time.Second,
	}
	go func() {
		log.Printf("Kube Cluster Connector %s listening on %s for cluster %s", connector.Version, cfg.Address, cfg.ClusterID)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdown); err != nil {
		log.Printf("shutdown failed: %v", err)
	}
}
