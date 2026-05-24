package cmd

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/huh"
	"github.com/hogsend/cli/internal/config"
	"github.com/hogsend/cli/internal/railway"
	"github.com/hogsend/cli/internal/tui"
	"github.com/spf13/cobra"
)

var journeysCmd = &cobra.Command{
	Use:   "journeys",
	Short: "Manage which journeys are active",
	Long:  "List, enable, or disable journeys for this deployment. Updates the ENABLED_JOURNEYS env var on Railway.",
	RunE:  runJourneys,
}

func runJourneys(cmd *cobra.Command, args []string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	fmt.Println(tui.Banner.Render("HOGSEND JOURNEYS"))
	fmt.Println()

	fmt.Println(tui.Label.Render("Currently enabled:"))
	if len(cfg.Journeys.Enabled) == 0 || (len(cfg.Journeys.Enabled) == 1 && cfg.Journeys.Enabled[0] == "*") {
		fmt.Println("  All journeys (*)")
	} else {
		for _, j := range cfg.Journeys.Enabled {
			fmt.Printf("  %s %s\n", tui.SuccessBadge.Render("+"), j)
		}
	}
	fmt.Println()

	var update bool
	confirmForm := huh.NewForm(
		huh.NewGroup(
			huh.NewConfirm().
				Title("Update journey selection?").
				Value(&update),
		),
	).WithTheme(huh.ThemeCatppuccin())

	if err := confirmForm.Run(); err != nil {
		return err
	}

	if !update {
		return nil
	}

	var selected []string
	selectForm := huh.NewForm(
		huh.NewGroup(
			huh.NewMultiSelect[string]().
				Title("Select journeys to enable").
				Options(journeyOptionsWithState(cfg.Journeys.Enabled)...).
				Value(&selected),
		),
	).WithTheme(huh.ThemeCatppuccin())

	if err := selectForm.Run(); err != nil {
		return err
	}

	journeyFilter := "*"
	if len(selected) > 0 && len(selected) < len(availableJourneys) {
		journeyFilter = strings.Join(selected, ",")
	}

	client := railway.NewClient(cfg.Railway.Token)

	if err := tui.RunWithSpinner("Updating ENABLED_JOURNEYS...", func() error {
		vars := map[string]string{"ENABLED_JOURNEYS": journeyFilter}
		if err := client.UpsertVariables(cfg.Railway.ProjectID, cfg.Railway.EnvironmentID, cfg.Railway.Services.API, vars); err != nil {
			return err
		}
		return client.UpsertVariables(cfg.Railway.ProjectID, cfg.Railway.EnvironmentID, cfg.Railway.Services.Worker, vars)
	}); err != nil {
		return err
	}

	if err := tui.RunWithSpinner("Redeploying services...", func() error {
		if err := client.RedeployService(cfg.Railway.Services.API, cfg.Railway.EnvironmentID); err != nil {
			return err
		}
		return client.RedeployService(cfg.Railway.Services.Worker, cfg.Railway.EnvironmentID)
	}); err != nil {
		return err
	}

	cfg.Journeys.Enabled = selected
	if err := config.Save(cfg); err != nil {
		return fmt.Errorf("save config: %w", err)
	}

	fmt.Println()
	fmt.Println(tui.SuccessBadge.Render("  Updated") + " Journeys updated and redeployed")

	return nil
}

func journeyOptionsWithState(current []string) []huh.Option[string] {
	currentSet := make(map[string]bool)
	for _, j := range current {
		currentSet[j] = true
	}

	allEnabled := len(current) == 0 || (len(current) == 1 && current[0] == "*")

	opts := make([]huh.Option[string], len(availableJourneys))
	for i, j := range availableJourneys {
		opts[i] = huh.NewOption(j, j).Selected(allEnabled || currentSet[j])
	}
	return opts
}
