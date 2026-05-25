package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSaveAndLoad(t *testing.T) {
	dir := t.TempDir()
	origDir, _ := os.Getwd()
	os.Chdir(dir)
	defer os.Chdir(origDir)

	cfg := &Config{
		Name:      "Test Corp",
		Slug:      "test-corp",
		CreatedAt: "2026-05-24T10:00:00Z",
		Railway: RailwayConfig{
			ProjectID:     "proj_123",
			EnvironmentID: "env_456",
			Services: ServiceIDs{
				API:    "svc_api",
				Worker: "svc_worker",
			},
			Domain: "test-corp.up.railway.app",
		},
		Journeys: JourneysConfig{
			Enabled: []string{"activation-welcome"},
		},
	}

	if err := Save(cfg); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	if _, err := os.Stat(filepath.Join(dir, configFileName)); err != nil {
		t.Fatalf("Config file not created: %v", err)
	}

	loaded, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	if loaded.Name != cfg.Name {
		t.Errorf("Name: got %q, want %q", loaded.Name, cfg.Name)
	}
	if loaded.Slug != cfg.Slug {
		t.Errorf("Slug: got %q, want %q", loaded.Slug, cfg.Slug)
	}
	if loaded.Railway.ProjectID != cfg.Railway.ProjectID {
		t.Errorf("ProjectID: got %q, want %q", loaded.Railway.ProjectID, cfg.Railway.ProjectID)
	}
	if loaded.Railway.Services.API != cfg.Railway.Services.API {
		t.Errorf("API ServiceID: got %q, want %q", loaded.Railway.Services.API, cfg.Railway.Services.API)
	}
	if len(loaded.Journeys.Enabled) != 1 || loaded.Journeys.Enabled[0] != "activation-welcome" {
		t.Errorf("Journeys: got %v, want [activation-welcome]", loaded.Journeys.Enabled)
	}
}

func TestExists(t *testing.T) {
	dir := t.TempDir()
	origDir, _ := os.Getwd()
	os.Chdir(dir)
	defer os.Chdir(origDir)

	if Exists() {
		t.Error("Exists() should return false when no config file")
	}

	Save(&Config{Name: "test", Slug: "test"})

	if !Exists() {
		t.Error("Exists() should return true after saving")
	}
}

func TestLoadMissing(t *testing.T) {
	dir := t.TempDir()
	origDir, _ := os.Getwd()
	os.Chdir(dir)
	defer os.Chdir(origDir)

	_, err := Load()
	if err == nil {
		t.Error("Load() should fail when no config file exists")
	}
}

func TestPostHogConfig(t *testing.T) {
	dir := t.TempDir()
	origDir, _ := os.Getwd()
	os.Chdir(dir)
	defer os.Chdir(origDir)

	cfg := &Config{
		Name:      "PH Test",
		Slug:      "ph-test",
		CreatedAt: "2026-05-25T10:00:00Z",
		Railway: RailwayConfig{
			ProjectID: "proj_1",
			Domain:    "test.up.railway.app",
		},
		PostHog: PostHogConfig{
			ProjectID:      42,
			ProjectAPIKey:  "phc_abc123",
			PersonalAPIKey: "phx_def456",
			Host:           "https://us.i.posthog.com",
			WebhookDestID:  "hog_xyz",
		},
		Journeys: JourneysConfig{Enabled: []string{"*"}},
		APIKey:   "admin_key_123",
	}

	if err := Save(cfg); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	loaded, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	if loaded.PostHog.ProjectID != 42 {
		t.Errorf("PostHog.ProjectID: got %d, want 42", loaded.PostHog.ProjectID)
	}
	if loaded.PostHog.ProjectAPIKey != "phc_abc123" {
		t.Errorf("PostHog.ProjectAPIKey: got %q", loaded.PostHog.ProjectAPIKey)
	}
	if loaded.PostHog.PersonalAPIKey != "phx_def456" {
		t.Errorf("PostHog.PersonalAPIKey: got %q", loaded.PostHog.PersonalAPIKey)
	}
	if loaded.PostHog.Host != "https://us.i.posthog.com" {
		t.Errorf("PostHog.Host: got %q", loaded.PostHog.Host)
	}
	if loaded.PostHog.WebhookDestID != "hog_xyz" {
		t.Errorf("PostHog.WebhookDestID: got %q", loaded.PostHog.WebhookDestID)
	}
	if loaded.APIKey != "admin_key_123" {
		t.Errorf("APIKey: got %q", loaded.APIKey)
	}
}

func TestBackwardCompatNoPostHog(t *testing.T) {
	dir := t.TempDir()
	origDir, _ := os.Getwd()
	os.Chdir(dir)
	defer os.Chdir(origDir)

	cfg := &Config{
		Name:      "Old Config",
		Slug:      "old",
		CreatedAt: "2026-01-01T00:00:00Z",
		Railway: RailwayConfig{
			ProjectID: "proj_old",
			Domain:    "old.up.railway.app",
		},
		Journeys: JourneysConfig{Enabled: []string{"activation-welcome"}},
	}

	if err := Save(cfg); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	loaded, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	if loaded.PostHog.ProjectID != 0 {
		t.Errorf("PostHog.ProjectID should be zero value, got %d", loaded.PostHog.ProjectID)
	}
	if loaded.PostHog.Host != "" {
		t.Errorf("PostHog.Host should be empty, got %q", loaded.PostHog.Host)
	}
	if loaded.APIKey != "" {
		t.Errorf("APIKey should be empty, got %q", loaded.APIKey)
	}
}
