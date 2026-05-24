package cmd

import (
	"fmt"
	"strings"

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

func apiURL(domain string) string {
	if strings.HasPrefix(domain, "localhost") || strings.HasPrefix(domain, "127.0.0.1") {
		return fmt.Sprintf("http://%s", domain)
	}
	return fmt.Sprintf("https://%s", domain)
}

func runStatus(cmd *cobra.Command, args []string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	url := apiURL(cfg.Railway.Domain)
	isLocal := strings.HasPrefix(cfg.Railway.Domain, "localhost")

	fmt.Println(tui.Banner.Render("HOGSEND STATUS"))
	fmt.Println()

	h, err := health.Check(url)

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
			"- **API:** %s\n",
		cfg.Name,
		cfg.Slug,
		url,
	)

	if !isLocal && cfg.Railway.ProjectID != "" {
		md += fmt.Sprintf("- **Railway:** https://railway.com/project/%s\n", cfg.Railway.ProjectID)
	}

	md += fmt.Sprintf(
		"\n### Health\n\n%s\n"+
			"### Journeys\n\n"+
			"- **Enabled:** %v\n",
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
