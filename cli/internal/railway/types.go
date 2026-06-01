package railway

type Project struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Service struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Environment struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Deployment struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

type ServiceDomain struct {
	Domain string `json:"domain"`
}

type Variable struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}
