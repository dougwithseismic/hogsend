package api

type Contact struct {
	ID         string                 `json:"id"`
	ExternalID string                 `json:"externalId"`
	Email      *string                `json:"email"`
	Properties map[string]interface{} `json:"properties"`
	FirstSeenAt string               `json:"firstSeenAt"`
	LastSeenAt  string               `json:"lastSeenAt"`
	CreatedAt   string               `json:"createdAt"`
	UpdatedAt   string               `json:"updatedAt"`
}

type EmailPreference struct {
	ID              string          `json:"id"`
	UserID          string          `json:"userId"`
	Email           string          `json:"email"`
	UnsubscribedAll bool            `json:"unsubscribedAll"`
	Suppressed      bool            `json:"suppressed"`
	BounceCount     int             `json:"bounceCount"`
	Categories      map[string]bool `json:"categories"`
	SuppressedAt    *string         `json:"suppressedAt"`
	LastBounceAt    *string         `json:"lastBounceAt"`
}

type ListContactsResponse struct {
	Contacts []Contact `json:"contacts"`
	Total    int       `json:"total"`
	Limit    int       `json:"limit"`
	Offset   int       `json:"offset"`
}

type GetContactResponse struct {
	Contact     Contact          `json:"contact"`
	Preferences *EmailPreference `json:"preferences"`
}

type ContactResponse struct {
	Contact Contact `json:"contact"`
}

type DeleteResponse struct {
	Deleted bool `json:"deleted"`
}

type PreferencesResponse struct {
	Preferences EmailPreference `json:"preferences"`
}

type ErrorResponse struct {
	Error string `json:"error"`
}

type CreateContactInput struct {
	ExternalID string                 `json:"externalId"`
	Email      string                 `json:"email,omitempty"`
	Properties map[string]interface{} `json:"properties,omitempty"`
}

type UpdateContactInput struct {
	Email      string                 `json:"email,omitempty"`
	Properties map[string]interface{} `json:"properties,omitempty"`
}

type UpdatePreferencesInput struct {
	UnsubscribedAll *bool           `json:"unsubscribedAll,omitempty"`
	Suppressed      *bool           `json:"suppressed,omitempty"`
	Categories      map[string]bool `json:"categories,omitempty"`
}
