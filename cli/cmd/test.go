package cmd

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/hogsend/cli/internal/api"
	"github.com/hogsend/cli/internal/config"
	"github.com/hogsend/cli/internal/tui"
	"github.com/spf13/cobra"
)

var testCmd = &cobra.Command{
	Use:   "test",
	Short: "Send a test event and verify the pipeline",
	Long:  "Fires a synthetic event to the ingest endpoint and verifies it was stored by querying the admin API.",
	RunE:  runTest,
}

func runTest(cmd *cobra.Command, args []string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	if cfg.APIKey == "" {
		return fmt.Errorf("api_key not set in .hogsend.yaml — run 'hogsend init' to configure")
	}

	url := apiURL(cfg.Railway.Domain)

	fmt.Println(tui.Banner.Render("HOGSEND TEST"))
	fmt.Println()

	testID := generateTestID()
	startTime := time.Now()

	if err := tui.RunWithSpinner("Sending test event...", func() error {
		return ingestTestEvent(url, "hogsend:test", testID)
	}); err != nil {
		return err
	}

	client := api.NewClient(url, cfg.APIKey)
	var foundEvent *api.EventItem

	if err := tui.RunWithSpinner("Verifying event arrived...", func() error {
		for attempt := 0; attempt < 3; attempt++ {
			time.Sleep(2 * time.Second)

			result, err := client.ListEvents(10, "hogsend:test")
			if err != nil {
				continue
			}

			for _, evt := range result.Events {
				if props, ok := evt.Properties["testId"]; ok && props == testID {
					e := evt
					foundEvent = &e
					return nil
				}
			}
		}
		return nil
	}); err != nil {
		return err
	}

	fmt.Println()
	if foundEvent != nil {
		latency := time.Since(startTime).Round(time.Millisecond)
		content := fmt.Sprintf(
			"%s Pipeline is working\n\n"+
				"%s  %s\n"+
				"%s  %s\n"+
				"%s  %s\n"+
				"%s  %s",
			tui.SuccessBadge.Render("PASS"),
			tui.Label.Render("Event:"),
			tui.Value.Render("hogsend:test"),
			tui.Label.Render("Test ID:"),
			tui.Value.Render(testID),
			tui.Label.Render("Stored at:"),
			tui.Value.Render(foundEvent.OccurredAt),
			tui.Label.Render("Roundtrip:"),
			tui.Value.Render(latency.String()),
		)
		fmt.Println(tui.Card.Render(content))
	} else {
		content := fmt.Sprintf(
			"%s Event was accepted but not found in storage\n\n"+
				"This can happen if:\n"+
				"  - The database is still initializing\n"+
				"  - The Hatchet worker hasn't processed it yet\n"+
				"  - The ADMIN_API_KEY doesn't match\n\n"+
				"%s  %s\n"+
				"%s  %s",
			tui.WarningBadge.Render("WARN"),
			tui.Label.Render("API:"),
			tui.Value.Render(url),
			tui.Label.Render("Railway:"),
			tui.Value.Render("https://railway.com/project/"+cfg.Railway.ProjectID),
		)
		fmt.Println(tui.DimCard.Render(content))
	}

	return nil
}

func generateTestID() string {
	b := make([]byte, 4)
	rand.Read(b)
	return fmt.Sprintf("test-%d-%s", time.Now().Unix(), hex.EncodeToString(b))
}
