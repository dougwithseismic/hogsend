package railway

import (
	"encoding/json"
	"fmt"
)

func (c *Client) CreateProject(name string) (*Project, error) {
	data, err := c.do(`
		mutation($input: ProjectCreateInput!) {
			projectCreate(input: $input) {
				id
				name
			}
		}
	`, map[string]any{
		"input": map[string]any{
			"name": name,
		},
	})
	if err != nil {
		return nil, err
	}

	var result struct {
		ProjectCreate Project `json:"projectCreate"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("decode project: %w", err)
	}
	return &result.ProjectCreate, nil
}

func (c *Client) GetEnvironments(projectID string) ([]Environment, error) {
	data, err := c.do(`
		query($projectId: String!) {
			environments(projectId: $projectId) {
				edges {
					node {
						id
						name
					}
				}
			}
		}
	`, map[string]any{
		"projectId": projectID,
	})
	if err != nil {
		return nil, err
	}

	var result struct {
		Environments struct {
			Edges []struct {
				Node Environment `json:"node"`
			} `json:"edges"`
		} `json:"environments"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("decode environments: %w", err)
	}

	envs := make([]Environment, len(result.Environments.Edges))
	for i, edge := range result.Environments.Edges {
		envs[i] = edge.Node
	}
	return envs, nil
}

func (c *Client) CreateService(projectID, name string) (*Service, error) {
	data, err := c.do(`
		mutation($input: ServiceCreateInput!) {
			serviceCreate(input: $input) {
				id
				name
			}
		}
	`, map[string]any{
		"input": map[string]any{
			"projectId": projectID,
			"name":      name,
		},
	})
	if err != nil {
		return nil, err
	}

	var result struct {
		ServiceCreate Service `json:"serviceCreate"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("decode service: %w", err)
	}
	return &result.ServiceCreate, nil
}

func (c *Client) ConnectServiceToRepo(serviceID, repo, branch string) error {
	_, err := c.do(`
		mutation($id: String!, $input: ServiceUpdateInput!) {
			serviceUpdate(id: $id, input: $input) {
				id
			}
		}
	`, map[string]any{
		"id": serviceID,
		"input": map[string]any{
			"source": map[string]any{
				"repo":   repo,
				"branch": branch,
			},
		},
	})
	return err
}

func (c *Client) SetServiceConfigFile(serviceID, environmentID, configFile string) error {
	_, err := c.do(`
		mutation($input: ServiceInstanceUpdateInput!) {
			serviceInstanceUpdate(input: $input) {
				id
			}
		}
	`, map[string]any{
		"input": map[string]any{
			"serviceId":     serviceID,
			"environmentId": environmentID,
			"railwayConfigFile": configFile,
		},
	})
	return err
}

func (c *Client) UpsertVariables(projectID, environmentID, serviceID string, vars map[string]string) error {
	_, err := c.do(`
		mutation($input: VariableCollectionUpsertInput!) {
			variableCollectionUpsert(input: $input)
		}
	`, map[string]any{
		"input": map[string]any{
			"projectId":     projectID,
			"environmentId": environmentID,
			"serviceId":     serviceID,
			"variables":     vars,
		},
	})
	return err
}

func (c *Client) GetVariables(projectID, environmentID, serviceID string) (map[string]string, error) {
	data, err := c.do(`
		query($projectId: String!, $environmentId: String!, $serviceId: String!) {
			variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
		}
	`, map[string]any{
		"projectId":     projectID,
		"environmentId": environmentID,
		"serviceId":     serviceID,
	})
	if err != nil {
		return nil, err
	}

	var result struct {
		Variables map[string]string `json:"variables"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("decode variables: %w", err)
	}
	return result.Variables, nil
}

func (c *Client) RedeployService(serviceID, environmentID string) error {
	_, err := c.do(`
		mutation($serviceId: String!, $environmentId: String!) {
			serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
		}
	`, map[string]any{
		"serviceId":     serviceID,
		"environmentId": environmentID,
	})
	return err
}

func (c *Client) GenerateServiceDomain(serviceID, environmentID string) (*ServiceDomain, error) {
	data, err := c.do(`
		mutation($input: ServiceDomainCreateInput!) {
			serviceDomainCreate(input: $input) {
				domain
			}
		}
	`, map[string]any{
		"input": map[string]any{
			"serviceId":     serviceID,
			"environmentId": environmentID,
		},
	})
	if err != nil {
		return nil, err
	}

	var result struct {
		ServiceDomainCreate ServiceDomain `json:"serviceDomainCreate"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("decode domain: %w", err)
	}
	return &result.ServiceDomainCreate, nil
}

func (c *Client) DeleteProject(projectID string) error {
	_, err := c.do(`
		mutation($id: String!) {
			projectDelete(id: $id)
		}
	`, map[string]any{
		"id": projectID,
	})
	return err
}

func (c *Client) GetDeployments(projectID, serviceID, environmentID string) ([]Deployment, error) {
	data, err := c.do(`
		query($input: DeploymentListInput!) {
			deployments(input: $input) {
				edges {
					node {
						id
						status
					}
				}
			}
		}
	`, map[string]any{
		"input": map[string]any{
			"projectId":     projectID,
			"serviceId":     serviceID,
			"environmentId": environmentID,
		},
	})
	if err != nil {
		return nil, err
	}

	var result struct {
		Deployments struct {
			Edges []struct {
				Node Deployment `json:"node"`
			} `json:"edges"`
		} `json:"deployments"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("decode deployments: %w", err)
	}

	deps := make([]Deployment, len(result.Deployments.Edges))
	for i, edge := range result.Deployments.Edges {
		deps[i] = edge.Node
	}
	return deps, nil
}

func (c *Client) WhoAmI() (string, error) {
	data, err := c.do(`query { me { email } }`, nil)
	if err != nil {
		return "", err
	}

	var result struct {
		Me struct {
			Email string `json:"email"`
		} `json:"me"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return "", fmt.Errorf("decode user: %w", err)
	}
	return result.Me.Email, nil
}
