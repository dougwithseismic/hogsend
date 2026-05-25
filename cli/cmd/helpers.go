package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/hogsend/cli/internal/api"
)

var ingestClient = &http.Client{Timeout: 15 * time.Second}

func ingestTestEvent(baseURL, event, testID string) error {
	payload := api.IngestEventInput{
		Event:     event,
		UserID:    "hogsend-cli-test",
		UserEmail: "test@hogsend.com",
		Properties: map[string]interface{}{
			"source":    "cli",
			"testId":    testID,
			"timestamp": time.Now().UTC().Format(time.RFC3339),
		},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}

	resp, err := ingestClient.Post(baseURL+"/v1/ingest/", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("could not reach API: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 202 {
		return fmt.Errorf("expected 202 Accepted, got %d", resp.StatusCode)
	}
	return nil
}
