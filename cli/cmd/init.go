package cmd

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/huh"
	"github.com/gosimple/slug"
	"github.com/hogsend/cli/internal/api"
	"github.com/hogsend/cli/internal/config"
	"github.com/hogsend/cli/internal/health"
	"github.com/hogsend/cli/internal/posthog"
	"github.com/hogsend/cli/internal/railway"
	"github.com/hogsend/cli/internal/tui"
	"github.com/spf13/cobra"
)

var forceInit bool

var availableJourneys = []string{
	"activation-welcome",
	"activation-nudge-series",
	"conversion-trial-upgrade",
	"conversion-abandoned-checkout",
	"retention-milestone",
	"referral-invite",
	"feedback-nps",
	"reactivation-dormancy",
	"churn-prevention",
	"test-onboarding",
}

var journeyEventMap = map[string][]string{
	"activation-welcome":           {"user_signed_up"},
	"activation-nudge-series":      {"user_signed_up"},
	"conversion-trial-upgrade":     {"trial_started"},
	"conversion-abandoned-checkout": {"checkout_abandoned"},
	"retention-milestone":          {"milestone_reached"},
	"referral-invite":              {"subscription_created"},
	"feedback-nps":                 {"subscription_created"},
	"reactivation-dormancy":        {"user_activated"},
	"churn-prevention":             {"subscription_cancelled", "payment_failed"},
	"test-onboarding":              {"test_signup"},
}

var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Configure a Hogsend deployment after Railway template deploy",
	Long: `Connect to an existing Railway project (created via the deploy template),
set environment variables, create a PostHog webhook destination, and verify
the full pipeline with a test event.

Deploy the template first: https://railway.com/deploy/sYUYH8?referralCode=dougie`,
	RunE: runInit,
}

func init() {
	initCmd.Flags().BoolVar(&forceInit, "force", false, "Re-initialize even if .hogsend.yaml exists")
}

func runInit(cmd *cobra.Command, args []string) error {
	if config.Exists() && !forceInit {
		cfg, err := config.Load()
		if err == nil && cfg != nil {
			return fmt.Errorf("already initialized as %q (slug: %s). Use --force to reconfigure or 'hogsend destroy' to start fresh", cfg.Name, cfg.Slug)
		}
	}

	fmt.Println(tui.Banner.Render("HOGSEND INIT"))
	fmt.Println(tui.Subtitle.Render("Configure your Hogsend deployment"))
	fmt.Println()

	// ── Stage 1: Collect ──────────────────────────────────────────────

	var clientName, railwayToken string

	if err := huh.NewForm(
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
		),
	).WithTheme(huh.ThemeCatppuccin()).Run(); err != nil {
		return err
	}

	railwayClient := railway.NewClient(railwayToken)

	var email string
	if err := tui.RunWithSpinner("Authenticating with Railway...", func() error {
		e, err := railwayClient.WhoAmI()
		if err != nil {
			return fmt.Errorf("invalid Railway token: %w", err)
		}
		email = e
		return nil
	}); err != nil {
		return err
	}
	fmt.Printf("  Authenticated as %s\n\n", tui.Value.Render(email))

	var railwayProjects []railway.Project
	if err := tui.RunWithSpinner("Fetching Railway projects...", func() error {
		p, err := railwayClient.ListProjects()
		if err != nil {
			return err
		}
		railwayProjects = p
		return nil
	}); err != nil {
		return err
	}

	if len(railwayProjects) == 0 {
		return fmt.Errorf("no Railway projects found. Deploy the template first: https://railway.com/deploy/sYUYH8?referralCode=dougie")
	}

	projectOptions := make([]huh.Option[string], len(railwayProjects))
	for i, p := range railwayProjects {
		projectOptions[i] = huh.NewOption(p.Name, p.ID)
	}

	var selectedProjectID string
	if err := huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Select your Hogsend Railway project").
				Description("Choose the project created by the deploy template").
				Options(projectOptions...).
				Value(&selectedProjectID),
		),
	).WithTheme(huh.ThemeCatppuccin()).Run(); err != nil {
		return err
	}

	var selectedProjectName string
	for _, p := range railwayProjects {
		if p.ID == selectedProjectID {
			selectedProjectName = p.Name
			break
		}
	}

	var (
		services    []railway.Service
		envs        []railway.Environment
		apiService  *railway.Service
		workerSvc   *railway.Service
	)

	if err := tui.RunWithSpinner("Discovering services...", func() error {
		s, err := railwayClient.GetServices(selectedProjectID)
		if err != nil {
			return err
		}
		services = s

		e, err := railwayClient.GetEnvironments(selectedProjectID)
		if err != nil {
			return err
		}
		if len(e) == 0 {
			return fmt.Errorf("no environments found in project")
		}
		envs = e
		return nil
	}); err != nil {
		return err
	}

	envID := envs[0].ID

	for i := range services {
		name := strings.ToLower(services[i].Name)
		if strings.Contains(name, "api") && !strings.Contains(name, "hatchet") {
			apiService = &services[i]
		}
		if strings.Contains(name, "worker") {
			workerSvc = &services[i]
		}
	}

	if apiService == nil {
		return fmt.Errorf("could not find API service in project %q. Expected a service containing 'api' in its name", selectedProjectName)
	}
	if workerSvc == nil {
		return fmt.Errorf("could not find Worker service in project %q. Expected a service containing 'worker' in its name", selectedProjectName)
	}

	fmt.Printf("  Found: %s (API), %s (Worker)\n\n", tui.Value.Render(apiService.Name), tui.Value.Render(workerSvc.Name))

	var apiDomain string
	if err := tui.RunWithSpinner("Finding API domain...", func() error {
		domains, err := railwayClient.GetServiceDomains(selectedProjectID, envID, apiService.ID)
		if err != nil {
			return err
		}
		if len(domains) > 0 {
			apiDomain = domains[0].Domain
			return nil
		}
		d, err := railwayClient.GenerateServiceDomain(apiService.ID, envID)
		if err != nil {
			return fmt.Errorf("generate domain: %w", err)
		}
		apiDomain = d.Domain
		return nil
	}); err != nil {
		return err
	}
	fmt.Printf("  API domain: %s\n\n", tui.Value.Render(apiDomain))

	var posthogKey, posthogRegion, posthogHost string

	if err := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("PostHog personal API key").
				Description("Generate at PostHog > Settings > Personal API Keys (starts with phx_)").
				Value(&posthogKey).
				EchoMode(huh.EchoModePassword).
				Validate(func(s string) error {
					if strings.TrimSpace(s) == "" {
						return fmt.Errorf("PostHog personal API key is required")
					}
					if !strings.HasPrefix(strings.TrimSpace(s), "phx_") {
						return fmt.Errorf("must start with 'phx_' — this is a personal API key, not the project key")
					}
					return nil
				}),
			huh.NewSelect[string]().
				Title("PostHog region").
				Options(
					huh.NewOption("US (us.i.posthog.com)", "https://us.i.posthog.com"),
					huh.NewOption("EU (eu.i.posthog.com)", "https://eu.i.posthog.com"),
					huh.NewOption("US (app.posthog.com)", "https://app.posthog.com"),
					huh.NewOption("Self-hosted (custom URL)", "custom"),
				).
				Value(&posthogRegion),
		),
	).WithTheme(huh.ThemeCatppuccin()).Run(); err != nil {
		return err
	}

	if posthogRegion == "custom" {
		if err := huh.NewForm(
			huh.NewGroup(
				huh.NewInput().
					Title("PostHog host URL").
					Placeholder("https://posthog.yourcompany.com").
					Value(&posthogHost).
					Validate(func(s string) error {
						if !strings.HasPrefix(s, "https://") {
							return fmt.Errorf("must start with https://")
						}
						return nil
					}),
			),
		).WithTheme(huh.ThemeCatppuccin()).Run(); err != nil {
			return err
		}
	} else {
		posthogHost = posthogRegion
	}

	posthogKey = strings.TrimSpace(posthogKey)
	phClient, err := posthog.NewClient(posthogKey, posthogHost)
	if err != nil {
		return err
	}

	var phProjects []posthog.Project
	if err := tui.RunWithSpinner("Fetching PostHog projects...", func() error {
		p, err := phClient.ListProjects()
		if err != nil {
			return err
		}
		phProjects = p
		return nil
	}); err != nil {
		return err
	}

	if len(phProjects) == 0 {
		return fmt.Errorf("no PostHog projects found. Check your personal API key has the right scopes")
	}

	phProjectOptions := make([]huh.Option[int], len(phProjects))
	for i, p := range phProjects {
		phProjectOptions[i] = huh.NewOption(p.Name, p.ID)
	}

	var (
		selectedPHProjectID int
		resendFrom          string
		enabledJourneys     []string
	)

	if err := huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[int]().
				Title("Which PostHog project should send events to Hogsend?").
				Options(phProjectOptions...).
				Value(&selectedPHProjectID),
		),
		huh.NewGroup(
			huh.NewInput().
				Title("Resend 'from' email").
				Description("The sender address for lifecycle emails").
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
			huh.NewMultiSelect[string]().
				Title("Which journeys to enable?").
				Description("Select journeys for this deployment").
				Options(journeyOptions()...).
				Value(&enabledJourneys),
		),
	).WithTheme(huh.ThemeCatppuccin()).Run(); err != nil {
		return err
	}

	var selectedPHProject posthog.Project
	for _, p := range phProjects {
		if p.ID == selectedPHProjectID {
			selectedPHProject = p
			break
		}
	}

	clientSlug := slug.Make(clientName)
	journeyFilter := "*"
	if len(enabledJourneys) > 0 && len(enabledJourneys) < len(availableJourneys) {
		journeyFilter = strings.Join(enabledJourneys, ",")
	}

	// ── Stage 2: Provision ────────────────────────────────────────────

	fmt.Println()
	fmt.Println(tui.Title.Render("Provisioning..."))

	authSecret := generateSecret(64)
	webhookSecret := generateSecret(32)
	adminAPIKey := generateSecret(32)

	baseURL := apiURL(apiDomain)

	apiVars := map[string]string{
		"NODE_ENV":              "production",
		"PORT":                  "3002",
		"LOG_LEVEL":             "info",
		"BETTER_AUTH_SECRET":    authSecret,
		"BETTER_AUTH_URL":       baseURL,
		"API_PUBLIC_URL":        baseURL,
		"POSTHOG_API_KEY":       selectedPHProject.APIToken,
		"POSTHOG_HOST":          posthogHost,
		"POSTHOG_WEBHOOK_SECRET": webhookSecret,
		"ADMIN_API_KEY":         adminAPIKey,
		"RESEND_FROM_EMAIL":     resendFrom,
		"ENABLED_JOURNEYS":      journeyFilter,
	}

	workerVars := map[string]string{
		"NODE_ENV":          "production",
		"LOG_LEVEL":         "info",
		"RESEND_FROM_EMAIL": resendFrom,
		"ENABLED_JOURNEYS":  journeyFilter,
		"POSTHOG_API_KEY":   selectedPHProject.APIToken,
		"POSTHOG_HOST":      posthogHost,
	}

	if err := tui.RunWithSpinner("Configuring API service...", func() error {
		return railwayClient.UpsertVariables(selectedProjectID, envID, apiService.ID, apiVars)
	}); err != nil {
		return fmt.Errorf("set API vars: %w", err)
	}

	if err := tui.RunWithSpinner("Configuring Worker service...", func() error {
		return railwayClient.UpsertVariables(selectedProjectID, envID, workerSvc.ID, workerVars)
	}); err != nil {
		return fmt.Errorf("set Worker vars: %w", err)
	}

	webhookEvents := collectWebhookEvents(enabledJourneys)

	var hogFunc *posthog.HogFunction
	if err := tui.RunWithSpinner("Creating PostHog webhook destination...", func() error {
		webhookURL := fmt.Sprintf("%s/v1/webhooks/posthog", baseURL)
		hf, err := phClient.CreateWebhookDestination(selectedPHProjectID, webhookURL, webhookSecret, webhookEvents)
		if err != nil {
			return err
		}
		hogFunc = hf
		return nil
	}); err != nil {
		return fmt.Errorf("PostHog webhook: %w", err)
	}

	if err := tui.RunWithSpinner("Redeploying API...", func() error {
		return railwayClient.RedeployService(apiService.ID, envID)
	}); err != nil {
		return fmt.Errorf("API redeploy: %w", err)
	}

	if err := tui.RunWithSpinner("Redeploying Worker...", func() error {
		return railwayClient.RedeployService(workerSvc.ID, envID)
	}); err != nil {
		return fmt.Errorf("Worker redeploy: %w", err)
	}

	// ── Stage 3: Verify ───────────────────────────────────────────────

	fmt.Println()
	fmt.Println(tui.Title.Render("Verifying deployment..."))

	if err := tui.RunWithSpinner("Waiting for API to become healthy (up to 3 min)...", func() error {
		_, err := health.WaitForHealthy(baseURL, 3*time.Minute)
		return err
	}); err != nil {
		fmt.Printf("\n  %s API did not become healthy in time.\n", tui.WarningBadge.Render("Warning:"))
		fmt.Printf("  Check the Railway dashboard: https://railway.com/project/%s\n", selectedProjectID)
		fmt.Println("  The configuration is saved — run 'hogsend status' to check later.")
	} else {
		if err := runTestEvent(baseURL, adminAPIKey); err != nil {
			fmt.Printf("\n  %s Test event failed: %s\n", tui.WarningBadge.Render("Warning:"), err)
			fmt.Println("  The deployment is configured — events may need a moment to process.")
		}
	}

	// ── Save config ───────────────────────────────────────────────────

	cfg := &config.Config{
		Name:      clientName,
		Slug:      clientSlug,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
		Railway: config.RailwayConfig{
			ProjectID:     selectedProjectID,
			EnvironmentID: envID,
			Services: config.ServiceIDs{
				API:    apiService.ID,
				Worker: workerSvc.ID,
			},
			Domain: apiDomain,
			Token:  railwayToken,
		},
		PostHog: config.PostHogConfig{
			ProjectID:      selectedPHProjectID,
			ProjectAPIKey:  selectedPHProject.APIToken,
			PersonalAPIKey: posthogKey,
			Host:           posthogHost,
			WebhookDestID:  hogFunc.ID,
		},
		Journeys: config.JourneysConfig{
			Enabled: enabledJourneys,
		},
		APIKey: adminAPIKey,
	}

	if err := config.Save(cfg); err != nil {
		return fmt.Errorf("save config: %w", err)
	}

	printInitSuccess(cfg)
	return nil
}

func runTestEvent(baseURL, apiKey string) error {
	client := api.NewClient(baseURL, apiKey)
	testID := fmt.Sprintf("init-%d-%s", time.Now().Unix(), generateSecret(8))

	if err := tui.RunWithSpinner("Sending test event...", func() error {
		return ingestTestEvent(baseURL, "hogsend:init_test", testID)
	}); err != nil {
		return err
	}

	if err := tui.RunWithSpinner("Verifying event pipeline...", func() error {
		for attempt := 0; attempt < 3; attempt++ {
			time.Sleep(2 * time.Second)
			result, err := client.ListEvents(5, "hogsend:init_test")
			if err != nil {
				continue
			}
			if len(result.Events) > 0 {
				return nil
			}
		}
		return fmt.Errorf("event not found after 3 attempts")
	}); err != nil {
		return err
	}

	return nil
}

func collectWebhookEvents(journeys []string) []string {
	seen := make(map[string]bool)
	var events []string

	targets := journeys
	if len(targets) == 0 {
		targets = availableJourneys
	}

	for _, j := range targets {
		if evts, ok := journeyEventMap[j]; ok {
			for _, e := range evts {
				if !seen[e] {
					seen[e] = true
					events = append(events, e)
				}
			}
		}
	}

	if len(events) == 0 {
		events = []string{
			"user_signed_up",
			"user_activated",
			"trial_started",
			"subscription_created",
			"subscription_cancelled",
			"payment_failed",
			"payment_succeeded",
			"feature_used",
		}
	}

	return events
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

func printInitSuccess(cfg *config.Config) {
	apiURL := apiURL(cfg.Railway.Domain)

	content := fmt.Sprintf(
		"%s %s\n\n"+
			"%s  %s\n"+
			"%s  %s\n"+
			"%s  %s\n\n"+
			"%s  %s\n"+
			"%s  %s\n"+
			"%s  %s\n\n"+
			"%s",
		tui.SuccessBadge.Render("SUCCESS"),
		"Hogsend is live",
		tui.Label.Render("API:"),
		tui.Value.Render(apiURL),
		tui.Label.Render("Webhook:"),
		tui.Value.Render(apiURL+"/v1/webhooks/posthog"),
		tui.Label.Render("PostHog:"),
		tui.Value.Render(fmt.Sprintf("project #%d → webhook destination created", cfg.PostHog.ProjectID)),
		tui.Label.Render("Railway:"),
		tui.Value.Render("https://railway.com/project/"+cfg.Railway.ProjectID),
		tui.Label.Render("Config:"),
		tui.Value.Render(".hogsend.yaml"),
		tui.Label.Render("Admin key:"),
		tui.Value.Render("saved in .hogsend.yaml (use with 'hogsend contacts', 'hogsend test')"),
		tui.Label.Render("Try it:")+" hogsend test",
	)

	fmt.Println()
	fmt.Println(tui.Card.Render(content))
}
