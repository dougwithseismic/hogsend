package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

type Client struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
}

func NewClient(baseURL, apiKey string) *Client {
	return &Client{
		baseURL: baseURL,
		apiKey:  apiKey,
		httpClient: &http.Client{
			Timeout: 15 * time.Second,
		},
	}
}

func (c *Client) do(method, path string, body interface{}) ([]byte, int, error) {
	var reqBody io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, 0, fmt.Errorf("failed to marshal request: %w", err)
		}
		reqBody = bytes.NewReader(data)
	}

	req, err := http.NewRequest(method, c.baseURL+path, reqBody)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	if err != nil {
		return nil, resp.StatusCode, fmt.Errorf("failed to read response: %w", err)
	}

	return respBody, resp.StatusCode, nil
}

func (c *Client) ListContacts(limit, offset int, search string) (*ListContactsResponse, error) {
	params := url.Values{}
	params.Set("limit", fmt.Sprintf("%d", limit))
	params.Set("offset", fmt.Sprintf("%d", offset))
	if search != "" {
		params.Set("search", search)
	}

	data, status, err := c.do("GET", "/v1/admin/contacts?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}

	if status != 200 {
		return nil, parseError(data, status)
	}

	var result ListContactsResponse
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}
	return &result, nil
}

func (c *Client) GetContact(id string) (*GetContactResponse, error) {
	data, status, err := c.do("GET", "/v1/admin/contacts/"+url.PathEscape(id), nil)
	if err != nil {
		return nil, err
	}

	if status != 200 {
		return nil, parseError(data, status)
	}

	var result GetContactResponse
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}
	return &result, nil
}

func (c *Client) CreateContact(input CreateContactInput) (*ContactResponse, error) {
	data, status, err := c.do("POST", "/v1/admin/contacts", input)
	if err != nil {
		return nil, err
	}

	if status != 201 {
		return nil, parseError(data, status)
	}

	var result ContactResponse
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}
	return &result, nil
}

func (c *Client) UpdateContact(id string, input UpdateContactInput) (*ContactResponse, error) {
	data, status, err := c.do("PATCH", "/v1/admin/contacts/"+url.PathEscape(id), input)
	if err != nil {
		return nil, err
	}

	if status != 200 {
		return nil, parseError(data, status)
	}

	var result ContactResponse
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}
	return &result, nil
}

func (c *Client) DeleteContact(id string) error {
	data, status, err := c.do("DELETE", "/v1/admin/contacts/"+url.PathEscape(id), nil)
	if err != nil {
		return err
	}

	if status != 200 {
		return parseError(data, status)
	}
	return nil
}

func (c *Client) GetPreferences(contactID string) (*PreferencesResponse, error) {
	data, status, err := c.do("GET", "/v1/admin/contacts/"+url.PathEscape(contactID)+"/preferences", nil)
	if err != nil {
		return nil, err
	}

	if status != 200 {
		return nil, parseError(data, status)
	}

	var result PreferencesResponse
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}
	return &result, nil
}

func (c *Client) UpdatePreferences(contactID string, input UpdatePreferencesInput) (*PreferencesResponse, error) {
	data, status, err := c.do("PUT", "/v1/admin/contacts/"+url.PathEscape(contactID)+"/preferences", input)
	if err != nil {
		return nil, err
	}

	if status != 200 {
		return nil, parseError(data, status)
	}

	var result PreferencesResponse
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}
	return &result, nil
}

func (c *Client) ListEvents(limit int, event string) (*ListEventsResponse, error) {
	params := url.Values{}
	params.Set("limit", fmt.Sprintf("%d", limit))
	if event != "" {
		params.Set("event", event)
	}

	data, status, err := c.do("GET", "/v1/admin/events?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}

	if status != 200 {
		return nil, parseError(data, status)
	}

	var result ListEventsResponse
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}
	return &result, nil
}

func parseError(data []byte, status int) error {
	var errResp ErrorResponse
	if err := json.Unmarshal(data, &errResp); err == nil && errResp.Error != "" {
		return fmt.Errorf("API error (%d): %s", status, errResp.Error)
	}
	return fmt.Errorf("API error: HTTP %d", status)
}
