package cmd

import (
	"fmt"

	"github.com/charmbracelet/glamour"
	"github.com/hogsend/cli/internal/config"
	"github.com/hogsend/cli/internal/health"
	"github.com/hogsend/cli/internal/tui"
	"github.com/spf13/cobra"
)

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Check health of this deployment",
	RunE:  runStatus,
}

func runStatus(cmd *cobra.Command, args []string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	apiURL := fmt.Sprintf("https://%s", cfg.Railway.Domain)

	fmt.Println(tui.Banner.Render("HOGSEND STATUS"))
	fmt.Println()

	h, err := health.Check(apiURL)

	var statusLine string
	if err != nil {
		statusLine = fmt.Sprintf("- **Status:** %s\n", tui.ErrorBadge.Render("unhealthy"))
		statusLine += fmt.Sprintf("- **Error:** %s\n", err.Error())
	} else {
		statusLine = fmt.Sprintf("- **Status:** %s\n", tui.SuccessBadge.Render("healthy"))
		statusLine += fmt.Sprintf("- **Version:** %s\n", h.Version)
		statusLine += fmt.Sprintf("- **Uptime:** %.0f seconds\n", h.Uptime)
	}

	md := fmt.Sprintf(
		"## %s\n\n"+
			"- **Slug:** %s\n"+
			"- **API:** %s\n"+
			"- **Railway:** https://railway.com/project/%s\n\n"+
			"### Health\n\n%s\n"+
			"### Journeys\n\n"+
			"- **Enabled:** %v\n",
		cfg.Name,
		cfg.Slug,
		apiURL,
		cfg.Railway.ProjectID,
		statusLine,
		cfg.Journeys.Enabled,
	)

	out, err := glamour.Render(md, "dark")
	if err != nil {
		fmt.Println(md)
		return nil
	}
	fmt.Print(out)

	return nil
}
