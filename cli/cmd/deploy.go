package cmd

import (
	"fmt"

	"github.com/hogsend/cli/internal/config"
	"github.com/hogsend/cli/internal/railway"
	"github.com/hogsend/cli/internal/tui"
	"github.com/spf13/cobra"
)

var deployCmd = &cobra.Command{
	Use:   "deploy",
	Short: "Trigger a Railway deploy for API + Worker",
	RunE:  runDeploy,
}

func runDeploy(cmd *cobra.Command, args []string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	fmt.Println(tui.Banner.Render("HOGSEND DEPLOY"))
	fmt.Println(tui.Subtitle.Render(fmt.Sprintf("Deploying %s", cfg.Name)))
	fmt.Println()

	client := railway.NewClient(cfg.Railway.Token)

	if err := tui.RunWithSpinner("Redeploying API...", func() error {
		return client.RedeployService(cfg.Railway.Services.API, cfg.Railway.EnvironmentID)
	}); err != nil {
		return fmt.Errorf("API redeploy failed: %w", err)
	}

	if err := tui.RunWithSpinner("Redeploying Worker...", func() error {
		return client.RedeployService(cfg.Railway.Services.Worker, cfg.Railway.EnvironmentID)
	}); err != nil {
		return fmt.Errorf("Worker redeploy failed: %w", err)
	}

	fmt.Println()
	fmt.Println(tui.SuccessBadge.Render("  Deploy triggered"))
	fmt.Printf("  Track progress: %s\n", tui.Value.Render(fmt.Sprintf("https://railway.com/project/%s", cfg.Railway.ProjectID)))

	return nil
}
