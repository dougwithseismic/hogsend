package posthog

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNewClientValidatesPrefix(t *testing.T) {
	_, err := NewClient("bad_key", "")
	if err == nil {
		t.Fatal("expected error for non-phx_ key")
	}

	c, err := NewClient("phx_valid_key", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.baseURL != "https://us.i.posthog.com" {
		t.Errorf("default host: got %q, want %q", c.baseURL, "https://us.i.posthog.com")
	}
}

func TestNewClientCustomHost(t *testing.T) {
	c, err := NewClient("phx_test", "https://eu.i.posthog.com")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.baseURL != "https://eu.i.posthog.com" {
		t.Errorf("host: got %q, want %q", c.baseURL, "https://eu.i.posthog.com")
	}
}

func TestNewClientTrimsTrailingSlash(t *testing.T) {
	c, err := NewClient("phx_test", "https://posthog.example.com/")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.baseURL != "https://posthog.example.com" {
		t.Errorf("host: got %q, want %q", c.baseURL, "https://posthog.example.com")
	}
}

func TestListProjects(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/projects/" {
			t.Errorf("path: got %q, want %q", r.URL.Path, "/api/projects/")
		}
		if r.Method != "GET" {
			t.Errorf("method: got %q, want GET", r.Method)
		}
		if r.Header.Get("Authorization") != "Bearer phx_test_key" {
			t.Errorf("auth header: got %q", r.Header.Get("Authorization"))
		}

		json.NewEncoder(w).Encode(paginatedResponse[Project]{
			Count: 2,
			Results: []Project{
				{ID: 1, Name: "My App", APIToken: "phc_abc123"},
				{ID: 2, Name: "Staging", APIToken: "phc_def456"},
			},
		})
	}))
	defer srv.Close()

	c := &Client{
		apiKey:     "phx_test_key",
		baseURL:    srv.URL,
		httpClient: srv.Client(),
	}

	projects, err := c.ListProjects()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(projects) != 2 {
		t.Fatalf("projects count: got %d, want 2", len(projects))
	}
	if projects[0].Name != "My App" {
		t.Errorf("project name: got %q, want %q", projects[0].Name, "My App")
	}
	if projects[0].APIToken != "phc_abc123" {
		t.Errorf("api token: got %q, want %q", projects[0].APIToken, "phc_abc123")
	}
}

func TestListProjectsAuthError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"detail":"Invalid token"}`))
	}))
	defer srv.Close()

	c := &Client{
		apiKey:     "phx_bad",
		baseURL:    srv.URL,
		httpClient: srv.Client(),
	}

	_, err := c.ListProjects()
	if err == nil {
		t.Fatal("expected error for 401")
	}
}

func TestCreateWebhookDestination(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/projects/42/hog_functions/" {
			t.Errorf("path: got %q", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("method: got %q, want POST", r.Method)
		}

		var body createHogFunctionRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}

		if body.Name != "Hogsend" {
			t.Errorf("name: got %q, want %q", body.Name, "Hogsend")
		}
		if body.Type != "destination" {
			t.Errorf("type: got %q, want %q", body.Type, "destination")
		}
		if !body.Enabled {
			t.Error("expected enabled=true")
		}
		if body.CodeLanguage != "hog" {
			t.Errorf("code_language: got %q, want %q", body.CodeLanguage, "hog")
		}

		urlInput, ok := body.Inputs["url"]
		if !ok {
			t.Fatal("missing url input")
		}
		if urlInput.Value != "https://api.example.com/v1/webhooks/posthog" {
			t.Errorf("url: got %v", urlInput.Value)
		}

		headersInput, ok := body.Inputs["headers"]
		if !ok {
			t.Fatal("missing headers input")
		}
		headers, ok := headersInput.Value.(map[string]interface{})
		if !ok {
			t.Fatalf("headers type: got %T", headersInput.Value)
		}
		if headers["x-posthog-webhook-secret"] != "secret123" {
			t.Errorf("webhook secret: got %v", headers["x-posthog-webhook-secret"])
		}

		eventsRaw, ok := body.Filters["events"]
		if !ok {
			t.Fatal("missing events filter")
		}
		events, ok := eventsRaw.([]interface{})
		if !ok {
			t.Fatalf("events type: got %T", eventsRaw)
		}
		if len(events) != 2 {
			t.Fatalf("events count: got %d, want 2", len(events))
		}
		evt0, _ := events[0].(map[string]interface{})
		if evt0["id"] != "user_signed_up" {
			t.Errorf("event 0: got %v, want %q", evt0["id"], "user_signed_up")
		}
		evt1, _ := events[1].(map[string]interface{})
		if evt1["id"] != "trial_started" {
			t.Errorf("event 1: got %v, want %q", evt1["id"], "trial_started")
		}

		w.WriteHeader(201)
		json.NewEncoder(w).Encode(HogFunction{
			ID:      "hog_abc123",
			Name:    "Hogsend",
			Enabled: true,
		})
	}))
	defer srv.Close()

	c := &Client{
		apiKey:     "phx_test",
		baseURL:    srv.URL,
		httpClient: srv.Client(),
	}

	hf, err := c.CreateWebhookDestination(
		42,
		"https://api.example.com/v1/webhooks/posthog",
		"secret123",
		[]string{"user_signed_up", "trial_started"},
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if hf.ID != "hog_abc123" {
		t.Errorf("id: got %q, want %q", hf.ID, "hog_abc123")
	}
	if !hf.Enabled {
		t.Error("expected enabled=true")
	}
}

func TestCreateWebhookDestinationError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		w.Write([]byte(`{"detail":"Invalid inputs"}`))
	}))
	defer srv.Close()

	c := &Client{
		apiKey:     "phx_test",
		baseURL:    srv.URL,
		httpClient: srv.Client(),
	}

	_, err := c.CreateWebhookDestination(42, "https://example.com", "secret", []string{"test"})
	if err == nil {
		t.Fatal("expected error for 400")
	}
}
