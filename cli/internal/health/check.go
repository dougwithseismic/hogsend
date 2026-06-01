package health

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type HealthResponse struct {
	Status    string  `json:"status"`
	Version   string  `json:"version"`
	Uptime    float64 `json:"uptime"`
	Timestamp string  `json:"timestamp"`
}

func Check(baseURL string) (*HealthResponse, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(baseURL + "/v1/health")
	if err != nil {
		return nil, fmt.Errorf("connection failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unhealthy: HTTP %d", resp.StatusCode)
	}

	var health HealthResponse
	if err := json.NewDecoder(resp.Body).Decode(&health); err != nil {
		return nil, fmt.Errorf("invalid response: %w", err)
	}

	return &health, nil
}

func WaitForHealthy(baseURL string, timeout time.Duration) (*HealthResponse, error) {
	deadline := time.Now().Add(timeout)
	interval := 5 * time.Second
	var lastErr error

	for time.Now().Before(deadline) {
		health, err := Check(baseURL)
		if err == nil && health.Status == "healthy" {
			return health, nil
		}
		lastErr = err
		time.Sleep(interval)
	}

	if lastErr != nil {
		return nil, fmt.Errorf("timed out after %s: %w", timeout, lastErr)
	}
	return nil, fmt.Errorf("timed out after %s", timeout)
}
