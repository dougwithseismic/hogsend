package posthog

type Project struct {
	ID       int    `json:"id"`
	Name     string `json:"name"`
	APIToken string `json:"api_token"`
}

type HogFunction struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
}

type inputValue struct {
	Value any `json:"value"`
}

type eventFilter struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Type  string `json:"type"`
	Order int    `json:"order"`
}

type inputSchemaField struct {
	Key      string        `json:"key"`
	Type     string        `json:"type"`
	Label    string        `json:"label"`
	Required bool          `json:"required"`
	Choices  []inputChoice `json:"choices,omitempty"`
}

type inputChoice struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

type createHogFunctionRequest struct {
	Name         string             `json:"name"`
	Description  string             `json:"description"`
	Type         string             `json:"type"`
	CodeLanguage string             `json:"code_language"`
	Enabled      bool               `json:"enabled"`
	Hog          string             `json:"hog"`
	InputsSchema []inputSchemaField `json:"inputs_schema"`
	Inputs       map[string]inputValue `json:"inputs"`
	Filters      map[string]any     `json:"filters"`
}

type paginatedResponse[T any] struct {
	Count    int    `json:"count"`
	Next     string `json:"next"`
	Previous string `json:"previous"`
	Results  []T    `json:"results"`
}
