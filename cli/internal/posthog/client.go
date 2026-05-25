package posthog

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	apiKey     string
	baseURL    string
	httpClient *http.Client
}

func NewClient(personalAPIKey, host string) (*Client, error) {
	if !strings.HasPrefix(personalAPIKey, "phx_") {
		return nil, fmt.Errorf("invalid PostHog personal API key: must start with 'phx_'. Generate one at PostHog > Settings > Personal API Keys")
	}

	baseURL := strings.TrimRight(host, "/")
	if baseURL == "" {
		baseURL = "https://us.i.posthog.com"
	}

	return &Client{
		apiKey:  personalAPIKey,
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}, nil
}

func (c *Client) do(method, path string, body any) ([]byte, error) {
	var reqBody io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("marshal request: %w", err)
		}
		reqBody = bytes.NewReader(data)
	}

	req, err := http.NewRequest(method, c.baseURL+path, reqBody)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("API request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("PostHog API error (HTTP %d): %s", resp.StatusCode, truncate(string(respBody), 200))
	}

	return respBody, nil
}

func (c *Client) ListProjects() ([]Project, error) {
	data, err := c.do("GET", "/api/projects/", nil)
	if err != nil {
		return nil, err
	}

	var result paginatedResponse[Project]
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("decode projects: %w", err)
	}

	return result.Results, nil
}

func (c *Client) CreateWebhookDestination(projectID int, webhookURL, webhookSecret string, events []string) (*HogFunction, error) {
	eventFilters := make([]eventFilter, len(events))
	for i, e := range events {
		eventFilters[i] = eventFilter{
			ID:    e,
			Name:  e,
			Type:  "events",
			Order: i,
		}
	}

	payload := createHogFunctionRequest{
		Name:         "Hogsend",
		Description:  "Forward events to Hogsend lifecycle engine",
		Type:         "destination",
		CodeLanguage: "hog",
		Enabled:      true,
		Hog:          "fetch(inputs.url, {\n  'headers': inputs.headers,\n  'body': inputs.payload,\n  'method': inputs.method\n});",
		InputsSchema: []inputSchemaField{
			{Key: "url", Type: "string", Label: "Webhook URL", Required: true},
			{Key: "payload", Type: "json", Label: "JSON Payload", Required: true},
			{Key: "method", Type: "choice", Label: "HTTP Method", Required: true, Choices: []inputChoice{{Label: "POST", Value: "POST"}}},
			{Key: "headers", Type: "dictionary", Label: "Headers", Required: false},
		},
		Inputs: map[string]inputValue{
			"url":     {Value: webhookURL},
			"method":  {Value: "POST"},
			"headers": {Value: map[string]string{"x-posthog-webhook-secret": webhookSecret}},
			"payload": {Value: map[string]string{"event": "{event}", "person": "{person}"}},
		},
		Filters: map[string]any{
			"events":               eventFilters,
			"filter_test_accounts": true,
		},
	}

	data, err := c.do("POST", fmt.Sprintf("/api/projects/%d/hog_functions/", projectID), payload)
	if err != nil {
		return nil, err
	}

	var result HogFunction
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("decode hog function: %w", err)
	}

	return &result, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

