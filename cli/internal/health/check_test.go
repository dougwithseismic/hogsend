package health

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestCheckHealthy(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/health" {
			w.WriteHeader(404)
			return
		}
		json.NewEncoder(w).Encode(HealthResponse{
			Status:  "healthy",
			Version: "0.0.1",
			Uptime:  42.5,
		})
	}))
	defer srv.Close()

	h, err := Check(srv.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if h.Status != "healthy" {
		t.Errorf("status: got %q, want %q", h.Status, "healthy")
	}
	if h.Version != "0.0.1" {
		t.Errorf("version: got %q, want %q", h.Version, "0.0.1")
	}
}

func TestCheckUnhealthy(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
	}))
	defer srv.Close()

	_, err := Check(srv.URL)
	if err == nil {
		t.Error("expected error for unhealthy server")
	}
}

func TestCheckUnreachable(t *testing.T) {
	_, err := Check("http://localhost:1")
	if err == nil {
		t.Error("expected error for unreachable server")
	}
}

func TestWaitForHealthy(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls < 2 {
			w.WriteHeader(500)
			return
		}
		json.NewEncoder(w).Encode(HealthResponse{Status: "healthy", Version: "0.0.1"})
	}))
	defer srv.Close()

	h, err := WaitForHealthy(srv.URL, 30*time.Second)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if h.Status != "healthy" {
		t.Errorf("status: got %q, want %q", h.Status, "healthy")
	}
}
