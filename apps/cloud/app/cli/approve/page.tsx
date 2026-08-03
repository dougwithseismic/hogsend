import type { Metadata } from "next";
import { headers } from "next/headers";
import { CliApproveForm } from "@/components/cloud/cli-approve-form";
import { Card } from "@/components/ds/card";
import { Hairline } from "@/components/ds/decor";
import { Section } from "@/components/ds/section";
import { PageHeader } from "@/components/shell/page-header";
import { describeCliDevice } from "@/src/lib/cli-sessions-ops";
import { requireActiveOrganization } from "@/src/lib/session";
import { normalizeUserCode } from "@/src/services/cli-device-codes";
import { decideCliDeviceAction } from "./actions";

export const metadata: Metadata = {
  title: "Approve a CLI login",
  description: "Authorize a machine running the Hogsend CLI.",
};

/**
 * `/cli/approve` — the human half of the device flow.
 *
 * The page shows what the approval hands over before it offers a button,
 * because approving a login is a grant and a grant you cannot read is not
 * consent:
 *  - the LABEL the requesting machine sent (a hostname), rendered as text and
 *    never trusted — the mint endpoint is unauthenticated, so this is a string
 *    a stranger chose and it can never be the thing you check;
 *  - the ORGANIZATION the session will be bound to — the caller's active org,
 *    which is what the approval actually hands over.
 *
 * `?code=` may be present — `hogsend login` opens this page with it so the
 * boxes below arrive filled and the human only confirms. It is used to look
 * the pending request up AND to prefill the input, a deliberate trade: the
 * code is short-lived, single-use, and approves nothing without this
 * signed-in session plus the explicit "I started this" confirmation, which
 * remains the guard against a forwarded link (RFC 8628 §5.4). The SERVER
 * still never mints a URL carrying a code.
 *
 * A signed-out visitor is bounced by the proxy and by `requireActiveOrganization`
 * alike, both of which carry the whole URL through the sign-in round trip.
 */

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <span className="font-medium text-sm text-white/80 tracking-[-0.02em]">
        {label}
      </span>
      <span className="text-sm text-white/60">{children}</span>
    </div>
  );
}

export default async function CliApprovePage({ searchParams }: PageProps) {
  const raw = (await searchParams).code;
  const supplied = Array.isArray(raw) ? raw[0] : raw;
  // Normalized before it reaches the round trip, so the URL a signed-out
  // visitor is sent back to survives sign-in unchanged. Used for the lookup
  // AND the prefill — see the module note.
  const code = supplied ? (normalizeUserCode(supplied) ?? "") : "";

  const { record } = await requireActiveOrganization({
    returnTo: code
      ? `/cli/approve?code=${encodeURIComponent(code)}`
      : "/cli/approve",
  });

  const request = code
    ? await describeCliDevice(await headers(), { userCode: code })
    : null;

  return (
    <main className="flex flex-1 flex-col">
      <PageHeader
        title="Approve a CLI login"
        description="A machine running `hogsend login` is waiting. Approving binds a CLI session to you, in this organization, until you revoke it in Settings."
      />

      <Section divider={false} containerClassName="flex flex-col gap-6">
        <Card className="p-0">
          <Row label="Requesting machine">
            {request?.label ? (
              <span className="font-mono text-xs">{request.label}</span>
            ) : (
              <span className="text-white/40">
                {code
                  ? "No pending login has that code."
                  : "Whatever the code below names."}
              </span>
            )}
          </Row>
          <Hairline />
          <Row label="Organization">{record.name}</Row>
          <Hairline />
          <Row label="Expires">
            {request ? (
              <span className="font-mono text-xs">
                {request.expiresAt.toISOString().slice(11, 19)} UTC
              </span>
            ) : (
              <span className="text-white/40">—</span>
            )}
          </Row>
        </Card>

        <Card className="flex flex-col gap-5">
          <p className="max-w-prose text-sm text-white/60 leading-6">
            Type the code from the terminal you ran `hogsend login` in. Never
            approve a code someone sent you: a CLI session can publish to this
            organization's environments if your role allows it, and it never
            gains more than your role has.
          </p>
          <CliApproveForm action={decideCliDeviceAction} initialCode={code} />
        </Card>
      </Section>
    </main>
  );
}
