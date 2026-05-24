package cmd

import (
	"fmt"
	"os"

	"github.com/charmbracelet/huh"
	"github.com/hogsend/cli/internal/config"
	"github.com/hogsend/cli/internal/railway"
	"github.com/hogsend/cli/internal/tui"
	"github.com/spf13/cobra"
)

var destroyCmd = &cobra.Command{
	Use:   "destroy",
	Short: "Tear down the Railway project for this deployment",
	Long:  "Permanently deletes the Railway project and all its services, databases, and data. This cannot be undone.",
	RunE:  runDestroy,
}

func runDestroy(cmd *cobra.Command, args []string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	fmt.Println(tui.Banner.Render("HOGSEND DESTROY"))
	fmt.Println()
	fmt.Println(tui.ErrorBadge.Render("WARNING:") + " This will permanently delete the Railway project")
	fmt.Printf("  Project: %s (%s)\n", tui.Label.Render(cfg.Name), cfg.Railway.ProjectID)
	fmt.Printf("  Domain:  %s\n\n", cfg.Railway.Domain)

	var confirmation string
	confirmForm := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title(fmt.Sprintf("Type '%s' to confirm deletion", cfg.Slug)).
				Value(&confirmation),
		),
	).WithTheme(huh.ThemeCatppuccin())

	if err := confirmForm.Run(); err != nil {
		return err
	}

	if confirmation != cfg.Slug {
		fmt.Println("\n  Aborted. Slug did not match.")
		return nil
	}

	client := railway.NewClient(cfg.Railway.Token)

	if err := tui.RunWithSpinner("Deleting Railway project...", func() error {
		return client.DeleteProject(cfg.Railway.ProjectID)
	}); err != nil {
		return fmt.Errorf("delete failed: %w", err)
	}

	if err := os.Remove(config.ConfigPath()); err != nil && !os.IsNotExist(err) {
		fmt.Printf("  Warning: could not remove %s: %v\n", config.ConfigPath(), err)
	}

	fmt.Println()
	fmt.Println(tui.SuccessBadge.Render("  Destroyed") + fmt.Sprintf(" %s has been deleted", cfg.Name))

	return nil
}
