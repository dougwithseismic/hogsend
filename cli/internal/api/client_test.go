package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestListEvents(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/admin/events" {
			t.Errorf("path: got %q, want /v1/admin/events", r.URL.Path)
		}
		if r.URL.Query().Get("limit") != "5" {
			t.Errorf("limit: got %q, want 5", r.URL.Query().Get("limit"))
		}
		if r.URL.Query().Get("event") != "hogsend:test" {
			t.Errorf("event: got %q, want hogsend:test", r.URL.Query().Get("event"))
		}
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("auth: got %q", r.Header.Get("Authorization"))
		}

		json.NewEncoder(w).Encode(ListEventsResponse{
			Events: []EventItem{
				{
					ID:     "evt_1",
					UserID: "user_1",
					Event:  "hogsend:test",
					Properties: map[string]interface{}{
						"testId": "test-123",
						"source": "cli",
					},
					OccurredAt: "2026-05-25T10:00:00Z",
				},
			},
			Total:  1,
			Limit:  5,
			Offset: 0,
		})
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "test-key")
	result, err := client.ListEvents(5, "hogsend:test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(result.Events) != 1 {
		t.Fatalf("events count: got %d, want 1", len(result.Events))
	}
	if result.Events[0].Event != "hogsend:test" {
		t.Errorf("event: got %q", result.Events[0].Event)
	}
	if result.Events[0].Properties["testId"] != "test-123" {
		t.Errorf("testId: got %v", result.Events[0].Properties["testId"])
	}
}

func TestListEventsAuthError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		json.NewEncoder(w).Encode(ErrorResponse{Error: "unauthorized"})
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "bad-key")
	_, err := client.ListEvents(5, "")
	if err == nil {
		t.Fatal("expected error for 401")
	}
}

func TestNewClient(t *testing.T) {
	c := NewClient("http://localhost:3002", "my-key")
	if c.baseURL != "http://localhost:3002" {
		t.Errorf("baseURL: got %q", c.baseURL)
	}
	if c.apiKey != "my-key" {
		t.Errorf("apiKey: got %q", c.apiKey)
	}
}
