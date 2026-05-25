package cmd

import (
	"testing"
)

func TestCollectWebhookEvents(t *testing.T) {
	events := collectWebhookEvents([]string{"activation-welcome", "conversion-trial-upgrade"})

	seen := make(map[string]bool)
	for _, e := range events {
		seen[e] = true
	}

	if !seen["user_signed_up"] {
		t.Error("missing user_signed_up from activation-welcome")
	}
	if !seen["trial_started"] {
		t.Error("missing trial_started from conversion-trial-upgrade")
	}
}

func TestCollectWebhookEventsDeduplicates(t *testing.T) {
	events := collectWebhookEvents([]string{"activation-welcome", "activation-nudge-series"})

	count := 0
	for _, e := range events {
		if e == "user_signed_up" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("user_signed_up should appear once, got %d", count)
	}
}

func TestCollectWebhookEventsEmpty(t *testing.T) {
	events := collectWebhookEvents(nil)

	if len(events) == 0 {
		t.Fatal("empty journeys should return default events")
	}

	seen := make(map[string]bool)
	for _, e := range events {
		seen[e] = true
	}
	if !seen["user_signed_up"] {
		t.Error("defaults should include user_signed_up")
	}
	if !seen["payment_failed"] {
		t.Error("defaults should include payment_failed")
	}
}

func TestGenerateSecret(t *testing.T) {
	s1 := generateSecret(32)
	s2 := generateSecret(32)

	if len(s1) != 32 {
		t.Errorf("length: got %d, want 32", len(s1))
	}
	if s1 == s2 {
		t.Error("two secrets should not be identical")
	}
}

func TestGenerateSecretLength(t *testing.T) {
	s := generateSecret(64)
	if len(s) != 64 {
		t.Errorf("length: got %d, want 64", len(s))
	}
}

func TestJourneyOptions(t *testing.T) {
	opts := journeyOptions()
	if len(opts) != len(availableJourneys) {
		t.Errorf("options count: got %d, want %d", len(opts), len(availableJourneys))
	}
}
