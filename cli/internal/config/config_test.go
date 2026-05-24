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
