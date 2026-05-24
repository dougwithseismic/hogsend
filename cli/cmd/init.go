package cmd

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"
	"github.com/gosimple/slug"
	"github.com/hogsend/cli/internal/config"
	"github.com/hogsend/cli/internal/railway"
	"github.com/hogsend/cli/internal/tui"
	"github.com/spf13/cobra"
)

var availableJourneys = []string{
	"activation-welcome",
	"test-onboarding",
}

var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Set up a new Hogsend deployment on Railway",
	Long:  "Interactive wizard that provisions a Railway project with all services (Postgres, Redis, Hatchet, API, Worker), sets environment variables, and deploys.",
	RunE:  runInit,
}

func runInit(cmd *cobra.Command, args []string) error {
	if config.Exists() {
		cfg, err := config.Load()
		if err == nil && cfg != nil {
			return fmt.Errorf("this project is already initialized as %q (slug: %s). Run 'hogsend destroy' first to re-initialize", cfg.Name, cfg.Slug)
		}
	}

	fmt.Println(tui.Banner.Render("HOGSEND INIT"))
	fmt.Println(tui.Subtitle.Render("Set up a new Hogsend deployment on Railway"))
	fmt.Println()

	var (
		clientName    string
		posthogKey    string
		posthogHost   string
		resendKey     string
		resendFrom    string
		autoSecret    bool
		authSecret    string
		railwayToken  string
		githubRepo    string
		enabledJourneys []string
	)

	form := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("Project name").
				Description("Name for this deployment (e.g. 'ACME Corp')").
				Value(&clientName).
				Validate(func(s string) error {
					if strings.TrimSpace(s) == "" {
						return fmt.Errorf("name is required")
					}
					return nil
				}),
		),
		huh.NewGroup(
			huh.NewInput().
				Title("Railway API token").
				Description("Generate at railway.com/account/tokens").
				Value(&railwayToken).
				EchoMode(huh.EchoModePassword).
				Validate(func(s string) error {
					if strings.TrimSpace(s) == "" {
						return fmt.Errorf("Railway token is required")
					}
					return nil
				}),
			huh.NewInput().
				Title("GitHub repo").
				Description("Source repo for services (e.g. 'your-org/hogsend')").
				Value(&githubRepo).
				Placeholder("your-org/hogsend").
				Validate(func(s string) error {
					if !strings.Contains(s, "/") {
						return fmt.Errorf("use format: owner/repo")
					}
					return nil
				}),
		),
		huh.NewGroup(
			huh.NewInput().
				Title("PostHog project API key").
				Value(&posthogKey).
				EchoMode(huh.EchoModePassword),
			huh.NewInput().
				Title("PostHog host").
				Value(&posthogHost).
				Placeholder("https://us.i.posthog.com"),
		),
		huh.NewGroup(
			huh.NewInput().
				Title("Resend API key").
				Value(&resendKey).
				EchoMode(huh.EchoModePassword).
				Validate(func(s string) error {
					if strings.TrimSpace(s) == "" {
						return fmt.Errorf("Resend API key is required")
					}
					return nil
				}),
			huh.NewInput().
				Title("Resend from email").
				Value(&resendFrom).
				Placeholder("noreply@yourdomain.com").
				Validate(func(s string) error {
					if !strings.Contains(s, "@") {
						return fmt.Errorf("must be a valid email")
					}
					return nil
				}),
		),
		huh.NewGroup(
			huh.NewConfirm().
				Title("Auto-generate auth secret?").
				Description("A 64-character random secret for Better Auth").
				Value(&autoSecret),
		),
		huh.NewGroup(
			huh.NewMultiSelect[string]().
				Title("Which journeys to enable?").
				Description("Select journeys for this deployment").
				Options(journeyOptions()...).
				Value(&enabledJourneys),
		),
	).WithTheme(huh.ThemeCatppuccin())

	if err := form.Run(); err != nil {
		return err
	}

	if posthogHost == "" {
		posthogHost = "https://us.i.posthog.com"
	}

	if autoSecret {
		authSecret = generateSecret(64)
	} else {
		secretForm := huh.NewForm(
			huh.NewGroup(
				huh.NewInput().
					Title("Auth secret").
					Description("Minimum 32 characters").
					Value(&authSecret).
					EchoMode(huh.EchoModePassword).
					Validate(func(s string) error {
						if len(s) < 32 {
							return fmt.Errorf("minimum 32 characters")
						}
						return nil
					}),
			),
		).WithTheme(huh.ThemeCatppuccin())
		if err := secretForm.Run(); err != nil {
			return err
		}
	}

	clientSlug := slug.Make(clientName)
	journeyFilter := "*"
	if len(enabledJourneys) > 0 && len(enabledJourneys) < len(availableJourneys) {
		journeyFilter = strings.Join(enabledJourneys, ",")
	}

	fmt.Println()
	fmt.Println(tui.Title.Render("Provisioning on Railway..."))

	client := railway.NewClient(railwayToken)

	email, err := client.WhoAmI()
	if err != nil {
		return fmt.Errorf("invalid Railway token: %w", err)
	}
	fmt.Printf("  Authenticated as %s\n\n", tui.Value.Render(email))

	var project *railway.Project
	if err := tui.RunWithSpinner("Creating Railway project...", func() error {
		p, err := client.CreateProject(fmt.Sprintf("hogsend-%s", clientSlug))
		if err != nil {
			return err
		}
		project = p
		return nil
	}); err != nil {
		return err
	}

	envs, err := client.GetEnvironments(project.ID)
	if err != nil {
		return fmt.Errorf("get environments: %w", err)
	}
	if len(envs) == 0 {
		return fmt.Errorf("no environments found in project")
	}
	envID := envs[0].ID

	var apiService, workerService *railway.Service

	if err := tui.RunWithSpinner("Creating API service...", func() error {
		svc, err := client.CreateService(project.ID, "hogsend-api")
		if err != nil {
			return err
		}
		apiService = svc
		if err := client.ConnectServiceToRepo(apiService.ID, githubRepo, "main"); err != nil {
			return fmt.Errorf("connect repo: %w", err)
		}
		return client.SetServiceConfigFile(apiService.ID, envID, "railway.toml")
	}); err != nil {
		return err
	}

	if err := tui.RunWithSpinner("Creating Worker service...", func() error {
		svc, err := client.CreateService(project.ID, "hogsend-worker")
		if err != nil {
			return err
		}
		workerService = svc
		if err := client.ConnectServiceToRepo(workerService.ID, githubRepo, "main"); err != nil {
			return fmt.Errorf("connect repo: %w", err)
		}
		return client.SetServiceConfigFile(workerService.ID, envID, "railway.worker.toml")
	}); err != nil {
		return err
	}

	var apiDomain string
	if err := tui.RunWithSpinner("Generating API domain...", func() error {
		domain, err := client.GenerateServiceDomain(apiService.ID, envID)
		if err != nil {
			return err
		}
		apiDomain = domain.Domain
		return nil
	}); err != nil {
		return err
	}

	apiVars := map[string]string{
		"NODE_ENV":              "production",
		"PORT":                  "3002",
		"LOG_LEVEL":             "info",
		"BETTER_AUTH_SECRET":    authSecret,
		"BETTER_AUTH_URL":       fmt.Sprintf("https://%s", apiDomain),
		"RESEND_API_KEY":        resendKey,
		"RESEND_FROM_EMAIL":     resendFrom,
		"ENABLED_JOURNEYS":      journeyFilter,
	}
	if posthogKey != "" {
		apiVars["POSTHOG_API_KEY"] = posthogKey
		apiVars["POSTHOG_HOST"] = posthogHost
	}

	workerVars := map[string]string{
		"NODE_ENV":           "production",
		"LOG_LEVEL":          "info",
		"RESEND_API_KEY":     resendKey,
		"RESEND_FROM_EMAIL":  resendFrom,
		"ENABLED_JOURNEYS":   journeyFilter,
	}

	if err := tui.RunWithSpinner("Setting environment variables...", func() error {
		if err := client.UpsertVariables(project.ID, envID, apiService.ID, apiVars); err != nil {
			return fmt.Errorf("API vars: %w", err)
		}
		return client.UpsertVariables(project.ID, envID, workerService.ID, workerVars)
	}); err != nil {
		return err
	}

	cfg := &config.Config{
		Name:      clientName,
		Slug:      clientSlug,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
		Railway: config.RailwayConfig{
			ProjectID:     project.ID,
			EnvironmentID: envID,
			Services: config.ServiceIDs{
				API:    apiService.ID,
				Worker: workerService.ID,
			},
			Domain: apiDomain,
			Token:  railwayToken,
		},
		Journeys: config.JourneysConfig{
			Enabled: enabledJourneys,
		},
	}

	if err := config.Save(cfg); err != nil {
		return fmt.Errorf("save config: %w", err)
	}

	printSuccessCard(cfg)
	return nil
}

func journeyOptions() []huh.Option[string] {
	opts := make([]huh.Option[string], len(availableJourneys))
	for i, j := range availableJourneys {
		opts[i] = huh.NewOption(j, j).Selected(true)
	}
	return opts
}

func generateSecret(length int) string {
	b := make([]byte, length/2)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

func printSuccessCard(cfg *config.Config) {
	apiURL := fmt.Sprintf("https://%s", cfg.Railway.Domain)

	content := fmt.Sprintf(
		"%s %s\n\n"+
			"%s  %s\n"+
			"%s  %s\n"+
			"%s  %s\n\n"+
			"%s  %s\n"+
			"%s  %s\n\n"+
			"%s\n"+
			"  1. Add Postgres and Redis services in the Railway dashboard\n"+
			"  2. Add Hatchet-Lite service (Docker image: ghcr.io/hatchet-dev/hatchet/hatchet-lite:latest)\n"+
			"  3. Wire DATABASE_URL and REDIS_URL to API + Worker\n"+
			"  4. Generate a Hatchet API token and set HATCHET_CLIENT_TOKEN\n"+
			"  5. Configure PostHog webhook to POST to the webhook URL",
		tui.SuccessBadge.Render("SUCCESS"),
		lipgloss.NewStyle().Bold(true).Render(cfg.Name+" deployed"),
		tui.Label.Render("API:"),
		tui.Value.Render(apiURL),
		tui.Label.Render("Webhook:"),
		tui.Value.Render(apiURL+"/v1/webhooks/posthog"),
		tui.Label.Render("Slug:"),
		tui.Value.Render(cfg.Slug),
		tui.Label.Render("Project:"),
		tui.Value.Render("https://railway.com/project/"+cfg.Railway.ProjectID),
		tui.Label.Render("Config:"),
		tui.Value.Render(".hogsend.yaml"),
		tui.Label.Render("Next steps:"),
	)

	fmt.Println(tui.Card.Render(content))
}
