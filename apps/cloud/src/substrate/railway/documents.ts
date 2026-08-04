/**
 * Every Railway GraphQL document the substrate uses, in one place.
 *
 * Ported from the Go CLI's `cli/internal/railway/queries.go` (same endpoint,
 * same field names) with the per-service mutations Hogsend Cloud needs on top.
 * `templateDeployV2` is deliberately NOT used: it deploys a whole template in
 * one shot and is the operation with the worst 400 rate, while the control
 * plane wants per-service control (region, replicas, image, variables) anyway.
 *
 * Each document is NAMED, and the name is the operation the emulator in
 * `substrate-railway.test.ts` dispatches on — so a renamed document without a
 * matching emulator arm fails the suite rather than silently no-opping.
 */

export const PROJECTS = `
  query Projects {
    projects {
      edges { node { id name } }
    }
  }
`;

export const PROJECT_CREATE = `
  mutation ProjectCreate($input: ProjectCreateInput!) {
    projectCreate(input: $input) { id name }
  }
`;

export const PROJECT_ENVIRONMENTS = `
  query ProjectEnvironments($projectId: String!) {
    environments(projectId: $projectId) {
      edges { node { id name } }
    }
  }
`;

export const PROJECT_SERVICES = `
  query ProjectServices($projectId: String!) {
    project(id: $projectId) {
      services {
        edges { node { id name } }
      }
    }
  }
`;

export const SERVICE_CREATE = `
  mutation ServiceCreate($input: ServiceCreateInput!) {
    serviceCreate(input: $input) { id name }
  }
`;

// serviceId/environmentId are TOP-LEVEL arguments on Railway's real schema,
// not ServiceInstanceUpdateInput fields — the wrapped-input shape passed the
// emulator but 400s live ("argument serviceId ... is required", found
// 2026-07-29 on the first live provision).
export const SERVICE_INSTANCE_UPDATE = `
  mutation ServiceInstanceUpdate($serviceId: String!, $environmentId: String, $input: ServiceInstanceUpdateInput!) {
    serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
  }
`;

export const SERVICE_INSTANCE_REDEPLOY = `
  mutation ServiceInstanceRedeploy($serviceId: String!, $environmentId: String!) {
    serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
  }
`;

/**
 * One read covering both halves of "is this service up": the desired replica
 * count (how suspend/resume is expressed) and the outcome of its last deploy.
 */
export const SERVICE_INSTANCE_STATUS = `
  query ServiceInstanceStatus($serviceId: String!, $environmentId: String!) {
    serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
      latestDeployment { id status }
    }
  }
`;

/**
 * Tear a service's container down while keeping the service, its variables,
 * its domains and its instance config.
 *
 * This is what `railway down` does, and Railway's own answer to "pause a
 * service": Remove "halts any further project resource consumption", so a
 * suspended tenant stops costing money — which is the entire business point of
 * suspend.
 *
 * Confirmed live: it is IDEMPOTENT (removing an already-removed id returns
 * true), and afterwards `serviceInstance.latestDeployment` is NULL rather than
 * carrying a removed status.
 */
export const DEPLOYMENT_REMOVE = `
  mutation DeploymentRemove($id: String!) {
    deploymentRemove(id: $id)
  }
`;

export const VARIABLE_COLLECTION_UPSERT = `
  mutation VariableCollectionUpsert($input: VariableCollectionUpsertInput!) {
    variableCollectionUpsert(input: $input)
  }
`;

export const VARIABLE_DELETE = `
  mutation VariableDelete($input: VariableDeleteInput!) {
    variableDelete(input: $input)
  }
`;

export const SERVICE_DOMAINS = `
  query ServiceDomains($projectId: String!, $environmentId: String!, $serviceId: String!) {
    domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
      serviceDomains { domain }
    }
  }
`;

/**
 * The custom domains on a service, WITH the records each one still needs.
 *
 * Exists for one reason: `customDomainCreate` sometimes answers before Railway
 * has computed `dnsRecords`, and a custom domain needs BOTH a CNAME and an
 * ownership TXT — a caller that publishes only the CNAME gets a domain that
 * 404s forever. So an empty create response is re-queried here rather than
 * guessed at.
 */
export const CUSTOM_DOMAINS = `
  query CustomDomains($projectId: String!, $environmentId: String!, $serviceId: String!) {
    domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
      customDomains {
        id
        domain
        status {
          verified
          certificateStatus
          certificateRetryable
          certificateErrorMessage
          dnsRecords {
            recordType
            hostlabel
            requiredValue
            zone
          }
        }
      }
    }
  }
`;

/**
 * Railway's certificate lifecycle, verbatim from the live schema.
 *
 * Only `VALID` serves HTTPS. `VALIDATING_OWNERSHIP` and `ISSUING` are the
 * normal path a fresh domain walks for a few minutes; `ISSUE_FAILED` is the
 * one terminal state, and it carries `certificateRetryable` to say whether
 * Railway will have another go by itself.
 */
export const CERTIFICATE_VALID = "CERTIFICATE_STATUS_TYPE_VALID";
export const CERTIFICATE_FAILED = "CERTIFICATE_STATUS_TYPE_ISSUE_FAILED";

export const SERVICE_DOMAIN_CREATE = `
  mutation ServiceDomainCreate($input: ServiceDomainCreateInput!) {
    serviceDomainCreate(input: $input) { domain }
  }
`;

export const CUSTOM_DOMAIN_CREATE = `
  mutation CustomDomainCreate($input: CustomDomainCreateInput!) {
    customDomainCreate(input: $input) {
      id
      domain
      status {
        dnsRecords {
          recordType
          hostlabel
          requiredValue
          zone
        }
      }
    }
  }
`;

export const SERVICE_DELETE = `
  mutation ServiceDelete($id: String!) {
    serviceDelete(id: $id)
  }
`;
