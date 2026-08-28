package connector

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"testing"

	"github.com/go-jose/go-jose/v4"
)

func TestLoopbackHost(t *testing.T) {
	for _, host := range []string{"localhost", "127.0.0.1", "::1"} {
		if !loopbackHost(host) {
			t.Fatalf("expected %q to be loopback", host)
		}
	}
	for _, host := range []string{"control-plane.example.com", "10.0.0.10", ""} {
		if loopbackHost(host) {
			t.Fatalf("expected %q not to be loopback", host)
		}
	}
}

func TestParsePublicKeysSupportsRotationJWKS(t *testing.T) {
	keys := make([]jose.JSONWebKey, 0, 2)
	for _, id := range []string{"old", "next"} {
		private, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		keys = append(keys, jose.JSONWebKey{
			Key: &private.PublicKey, KeyID: id, Algorithm: "ES256", Use: "sig",
		})
	}
	raw, err := json.Marshal(jose.JSONWebKeySet{Keys: keys})
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := parsePublicKeys(string(raw), "")
	if err != nil {
		t.Fatal(err)
	}
	if parsed["old"] == nil || parsed["next"] == nil || len(parsed) != 2 {
		t.Fatalf("unexpected parsed dispatch keys: %#v", parsed)
	}
}
