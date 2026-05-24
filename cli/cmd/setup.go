package cmd

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/hogsend/cli/internal/tui"
	"github.com/spf13/cobra"
)

var setupCmd = &cobra.Command{
	Use:   "setup",
	Short: "Set up local development environment",
	Long:  "Checks prerequisites, starts Docker containers, installs dependencies, and creates .env file.",
	RunE:  runSetup,
}

func runSetup(cmd *cobra.Command, args []string) error {
	fmt.Println(tui.Banner.Render("HOGSEND SETUP"))
	fmt.Println(tui.Subtitle.Render("Setting up local development environment"))
	fmt.Println()

	checks := []struct {
		name    string
		command string
		args    []string
	}{
		{"docker", "docker", []string{"--version"}},
		{"pnpm", "pnpm", []string{"--version"}},
		{"node", "node", []string{"--version"}},
	}

	for _, check := range checks {
		if err := tui.RunWithSpinner(fmt.Sprintf("Checking %s...", check.name), func() error {
			c := exec.Command(check.command, check.args...)
			return c.Run()
		}); err != nil {
			return fmt.Errorf("%s is required but not found. Install it and try again", check.name)
		}
	}

	if err := tui.RunWithSpinner("Checking Docker daemon...", func() error {
		return exec.Command("docker", "info").Run()
	}); err != nil {
		return fmt.Errorf("Docker is not running. Start Docker Desktop and try again")
	}

	if err := tui.RunWithSpinner("Starting containers (Postgres, Redis, Hatchet)...", func() error {
		c := exec.Command("docker", "compose", "up", "-d", "--wait", "--wait-timeout", "60")
		c.Stdout = os.Stdout
		c.Stderr = os.Stderr
		return c.Run()
	}); err != nil {
		return fmt.Errorf("docker compose failed: %w", err)
	}

	envExample := "apps/api/.env.example"
	envFile := "apps/api/.env"
	if _, err := os.Stat(envFile); os.IsNotExist(err) {
		if err := tui.RunWithSpinner("Creating .env from .env.example...", func() error {
			data, err := os.ReadFile(envExample)
			if err != nil {
				return err
			}
			return os.WriteFile(envFile, data, 0644)
		}); err != nil {
			return err
		}
	} else {
		fmt.Println(tui.SuccessBadge.Render("  Skip") + " .env already exists")
	}

	if err := tui.RunWithSpinner("Installing dependencies...", func() error {
		c := exec.Command("pnpm", "install")
		c.Stdout = os.Stdout
		c.Stderr = os.Stderr
		return c.Run()
	}); err != nil {
		return fmt.Errorf("pnpm install failed: %w", err)
	}

	fmt.Println()
	fmt.Println(tui.Card.Render(
		tui.SuccessBadge.Render("Ready to go!") + "\n\n" +
			"  pnpm dev              Start the API\n" +
			"  hatchet worker dev    Start the worker (separate terminal)\n\n" +
			"  Hatchet dashboard:    http://localhost:8888\n" +
			"  API:                  http://localhost:3002",
	))

	return nil
}
