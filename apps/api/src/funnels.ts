import { crmPipeline, defineFunnel } from "@hogsend/engine";

// DEMO: a second funnel so Studio's multi-funnel switcher is visible locally.
// The GHL "commercial" pipeline is claimed via the binding; "residential"
// keeps flowing into the synthesized default funnel. Registered by BOTH the
// API and the worker (same registry-mirror rule as connectors) so a future
// CRM provider's webhook and reconcile-poll paths stamp the same funnel.
export const commercialFunnel = defineFunnel({
  id: "commercial",
  name: "Commercial",
  stages: [
    "enquiry",
    "site_visit",
    { id: "proposal", milestone: "quoted" },
    { id: "contract_signed", milestone: "won" },
  ],
  bindings: [
    crmPipeline({
      provider: "ghl",
      pipeline: "commercial",
      stages: {
        "new-enquiry": "enquiry",
        "site-visit": "site_visit",
        "proposal-sent": "proposal",
        "contract-signed": "contract_signed",
      },
    }),
  ],
});

export const funnels = [commercialFunnel];
