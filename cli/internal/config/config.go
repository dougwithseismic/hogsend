package config

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

const configFileName = ".hogsend.yaml"

type Config struct {
	Name      string         `yaml:"name"`
	Slug      string         `yaml:"slug"`
	CreatedAt string         `yaml:"created_at"`
	Railway   RailwayConfig  `yaml:"railway"`
	Journeys  JourneysConfig `yaml:"journeys"`
}

type RailwayConfig struct {
	ProjectID     string          `yaml:"project_id"`
	EnvironmentID string          `yaml:"environment_id"`
	Services      ServiceIDs      `yaml:"services"`
	Domain        string          `yaml:"domain"`
	Token         string          `yaml:"token,omitempty"`
}

type ServiceIDs struct {
	API     string `yaml:"api"`
	Worker  string `yaml:"worker"`
	Hatchet string `yaml:"hatchet"`
}

type JourneysConfig struct {
	Enabled []string `yaml:"enabled"`
}

func ConfigPath() string {
	dir, _ := os.Getwd()
	return filepath.Join(dir, configFileName)
}

func Exists() bool {
	_, err := os.Stat(ConfigPath())
	return err == nil
}

func Load() (*Config, error) {
	data, err := os.ReadFile(ConfigPath())
	if err != nil {
		return nil, fmt.Errorf("no .hogsend.yaml found — run 'hogsend init' first")
	}

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("invalid .hogsend.yaml: %w", err)
	}

	return &cfg, nil
}

func Save(cfg *Config) error {
	data, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	return os.WriteFile(ConfigPath(), data, 0644)
}
