import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DnsRecord, EngineDomainStatus } from "@/lib/admin-api";
import {
  DEFAULT_RETURN_PATH_LABEL,
  planReturnPathSwitch,
  RETURN_PATH_COPY,
  ReturnPathCard,
  returnPathEnabledFrom,
  returnPathInvalidLabel,
  returnPathRecordsOf,
} from "@/views/setup-return-path";

// PRD 20 task 4 — the Setup upgrade card. Rendering runs through
// react-dom/server (static markup, no DOM environment), which covers exactly
// what the EARS criteria are about: WHAT renders in each state. The
// click-time decisions live in the pure `planReturnPathSwitch` and are tested
// directly.

const DKIM: DnsRecord = {
  type: "TXT",
  name: "hogsend._domainkey.acme.test",
  value: "p=FAKE",
  purpose: "dkim",
  status: "verified",
};

const RETURN_PATH_RECORDS: DnsRecord[] = [
  {
    type: "MX",
    name: "send.acme.test",
    value: "feedback-smtp.us-east-1.amazonses.com",
    priority: 10,
    purpose: "mx",
    status: "pending",
  },
  {
    type: "TXT",
    name: "send.acme.test",
    value: "v=spf1 include:amazonses.com ~all",
    purpose: "spf",
    status: "pending",
  },
];

function makeStatus(opts: {
  returnPathSupported?: boolean;
  records?: DnsRecord[];
}): EngineDomainStatus {
  // NOTE: `returnPathSupported` is spread conditionally so the older-engine
  // fixture OMITS the key entirely — if the mirror type ever makes the field
  // required, this stops compiling, which is the wire-skew law made a test.
  return {
    domain: "acme.test",
    providerId: "hogsend",
    supported: true,
    ...(opts.returnPathSupported === undefined
      ? {}
      : { returnPathSupported: opts.returnPathSupported }),
    status: {
      domain: "acme.test",
      state: "verified",
      records: opts.records ?? [DKIM],
      providerId: "hogsend",
      checkedAt: "2026-08-11T00:00:00.000Z",
    },
    testMode: {
      active: false,
      reason: null,
      redirectTo: null,
      fromOverride: null,
    },
  };
}

function render(data: EngineDomainStatus): string {
  return renderToStaticMarkup(
    <ReturnPathCard data={data} pending={false} onSet={() => {}} />,
  );
}

/** React escapes text nodes; compare copy against what the markup carries. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

describe("unavailable: no dead control", () => {
  it("renders no control against an older engine that never sends the field", () => {
    const html = render(makeStatus({}));
    expect(html).toContain(RETURN_PATH_COPY.unavailable);
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
  });

  it("renders no control when the provider cannot manage the return path", () => {
    const html = render(makeStatus({ returnPathSupported: false }));
    expect(html).toContain(RETURN_PATH_COPY.unavailable);
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain("<button");
  });
});

describe("off: the default, and not a warning state", () => {
  const html = render(makeStatus({ returnPathSupported: true }));

  it("renders the switch off with the benefit-first copy", () => {
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain(escapeHtml(RETURN_PATH_COPY.benefit));
    expect(html).toContain(escapeHtml(RETURN_PATH_COPY.mechanism));
  });

  it("carries no warning affordance for not having the upgrade", () => {
    // lucide's AlertTriangle renders a `triangle-alert` class; amber is the
    // Setup checklist's action tint. None of it may appear on an off card.
    expect(html).not.toMatch(
      /triangle-alert|amber|warning|action required|recommended/i,
    );
  });

  it("keeps the label picker behind a closed disclosure, defaulting to send", () => {
    expect(html).toContain("<details");
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    // The LITERAL, not the constant: `send` is a locked PRD 15/20 decision,
    // and asserting via the constant would follow a drifted default.
    expect(DEFAULT_RETURN_PATH_LABEL).toBe("send");
    expect(html).toContain('value="send"');
    expect(html).toContain(RETURN_PATH_COPY.labelSummary);
  });
});

describe("on: derived from the reported records", () => {
  const html = render(
    makeStatus({
      returnPathSupported: true,
      records: [DKIM, ...RETURN_PATH_RECORDS],
    }),
  );

  it("renders the switch on, with the bounce routing named", () => {
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("send.acme.test");
  });

  it("keeps the switch operable, so off is as reachable as on", () => {
    // No one-way door: the on-state switch must not render the disabled
    // ATTRIBUTE (`disabled=""`) — the bare token also appears inside
    // Tailwind's `disabled:` variant classes, which are fine.
    expect(html).toContain('role="switch"');
    expect(html).not.toContain('disabled=""');
  });
});

describe("record derivation", () => {
  it("reads off as off and on as on", () => {
    expect(returnPathEnabledFrom(makeStatus({}))).toBe(false);
    expect(
      returnPathEnabledFrom(
        makeStatus({ records: [DKIM, ...RETURN_PATH_RECORDS] }),
      ),
    ).toBe(true);
  });

  it("picks exactly the MX + SPF pair out of the record set", () => {
    const records = returnPathRecordsOf(
      makeStatus({ records: [DKIM, ...RETURN_PATH_RECORDS] }),
    );
    expect(records.map((r) => r.purpose).sort()).toEqual(["mx", "spf"]);
    expect(records.every((r) => r.status === "pending")).toBe(true);
  });
});

describe("planReturnPathSwitch", () => {
  it("off submits without a label", () => {
    expect(planReturnPathSwitch({ turnOn: false, label: "anything" })).toEqual({
      kind: "submit",
      body: { enabled: false },
    });
  });

  it("the default label (the literal send) is omitted from the wire", () => {
    expect(planReturnPathSwitch({ turnOn: true, label: "send" })).toEqual({
      kind: "submit",
      body: { enabled: true },
    });
  });

  it("an emptied input means the default", () => {
    expect(planReturnPathSwitch({ turnOn: true, label: "  " })).toEqual({
      kind: "submit",
      body: { enabled: true },
    });
  });

  it("a custom label is normalized (trim + lowercase) and sent", () => {
    expect(
      planReturnPathSwitch({ turnOn: true, label: " Notifications " }),
    ).toEqual({
      kind: "submit",
      body: { enabled: true, label: "notifications" },
    });
  });

  it("an invalid label is rejected BY NAME, before any submit", () => {
    const plan = planReturnPathSwitch({ turnOn: true, label: "no.dots" });
    expect(plan.kind).toBe("reject");
    if (plan.kind === "reject") {
      expect(plan.message).toContain('"no.dots"');
    }
  });
});

describe("copy law: the return path carries bounces", () => {
  // The misunderstanding PRD 20 exists to correct is "the return path brings
  // customer answers back". No string this upgrade adds may contain the
  // substring that starts that sentence.
  const FORBIDDEN = /repl/i;

  it("no copy string contains it", () => {
    expect(JSON.stringify(RETURN_PATH_COPY)).not.toMatch(FORBIDDEN);
    expect(returnPathInvalidLabel("no.dots")).not.toMatch(FORBIDDEN);
  });

  it("no rendered state contains it", () => {
    const states = [
      render(makeStatus({})),
      render(makeStatus({ returnPathSupported: true })),
      render(
        makeStatus({
          returnPathSupported: true,
          records: [DKIM, ...RETURN_PATH_RECORDS],
        }),
      ),
    ];
    expect(states.join("\n")).not.toMatch(FORBIDDEN);
  });
});
