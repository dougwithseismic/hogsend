import type { JSX } from "react";
import {
  revealIngestSnippetAction,
  revealStudioPasswordAction,
} from "@/app/environments/actions";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { Hairline } from "@/components/ds/decor";
import {
  PUBLISH_REPLACES_NOTE,
  SCAFFOLD_COMMANDS,
} from "@/src/lib/cloud-onboarding";
import { PROVISION_STEP_LABELS } from "@/src/lib/environment-detail";
import type {
  ProvisionProgress,
  TenantAccessView,
  TenantKeyView,
} from "@/src/lib/tenant-access";
import { AdvancedDisclosure } from "./advanced-disclosure";
import { RevealSecret } from "./reveal-secret";
import { CreateTenantKeyForm, RevokeTenantKeyForm } from "./tenant-keys-form";
import { TimeAgo } from "./time-ago";

/**
 * The customer's first five minutes: open Studio, sign in, paste a key into
 * their own repo.
 *
 * Everything here is drawn from `readTenantAccess`, which carries NO secret —
 * the password, the `.env` fragment and a freshly minted key each arrive only
 * as the return value of a server action the customer explicitly clicked.
 *
 * Each card leads with the thing it is about — the button, the address, the
 * snippet — under a small caption heading. Explanation sits under the value in
 * the caption size, and only where it carries a fact you cannot read off the
 * value itself.
 *
 * When the stack is not ready the block does not render an empty shell: it
 * says, in plain language, which step provisioning is on and whether anything
 * is retrying it.
 */
export function TenantAccessSection({
  access,
  progress,
  keys,
  keysError,
  now,
}: {
  access: TenantAccessView;
  progress: ProvisionProgress;
  keys: TenantKeyView[];
  /** Set when the tenant instance did not answer. Rendered as a sentence. */
  keysError: string | null;
  now: Date;
}): JSX.Element {
  if (!access.ready) {
    return <ProvisioningCard progress={progress} now={now} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <h2 className="eyebrow text-white/40">Studio</h2>
          {access.studioUrl ? (
            <div>
              <Button href={access.studioUrl} external icon>
                Open Studio
              </Button>
            </div>
          ) : null}
          <p className="max-w-prose text-white/45 text-xs leading-5">
            Contacts, journeys, emails and events, running on your own instance
            rather than on ours.
          </p>
        </div>
        <Hairline />
        <div className="flex flex-col gap-2">
          <h3 className="eyebrow text-white/40">Studio sign-in</h3>
          <span className="break-all font-mono text-base text-white">
            {access.adminEmail ?? "the organization owner"}
          </span>
        </div>

        {access.canReveal ? (
          <RevealSecret
            action={revealStudioPasswordAction}
            environmentId={access.environmentId}
            revealLabel="Show password"
            pendingLabel="Showing…"
            copyLabel="Studio password"
            warning={
              <>
                This is a Cloud-managed credential. Your instance closes public
                sign-up, so it is the only Studio account there is — changing
                its password inside Studio will stop the API key list, create
                and revoke on this page from working until it is set back. Tell
                us if you want your own login and we will add one.
              </>
            }
          />
        ) : (
          <p className="max-w-prose text-sm text-white/60 leading-6">
            Your role in this organization is {access.role}, so you can see this
            environment but not read its Studio password. Ask an owner or admin.
          </p>
        )}
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="eyebrow text-white/40">
          Your <code className="font-mono normal-case">.env</code>
        </h2>

        {access.canReveal ? (
          <RevealSecret
            action={revealIngestSnippetAction}
            environmentId={access.environmentId}
            revealLabel="Show .env snippet"
            pendingLabel="Showing…"
            copyLabel=".env snippet"
            block
            warning={
              <>
                This is a SECRET key — keep it server-side. Hogsend Cloud minted
                it for you (
                <span className="font-mono">{access.controlPlaneKeyName}</span>)
                and it stays valid until you rotate it.
              </>
            }
          />
        ) : (
          <p className="max-w-prose text-sm text-white/60 leading-6">
            Your role in this organization is {access.role}, so you can see this
            environment but not read its API key.
          </p>
        )}
        <p className="max-w-prose text-white/45 text-xs leading-5">
          Browser (&ldquo;publishable&rdquo;) keys are not issued from this page
          yet.
        </p>
      </Card>

      <NoRepoCard />

      <Card className="flex flex-col gap-5 p-0">
        <div className="flex flex-col gap-2 px-6 pt-6">
          <h2 className="eyebrow text-white/40">API keys</h2>
          <p className="max-w-prose text-white/45 text-xs leading-5">
            Read live from your instance. Keys created here carry the{" "}
            <code className="font-mono">ingest</code> scope only — never admin.
          </p>
        </div>

        <Hairline />

        <div className="flex flex-col">
          {keysError ? (
            <p className="max-w-prose px-6 py-4 text-sm text-white/60 leading-6">
              {keysError}
            </p>
          ) : null}

          {!keysError && keys.length === 0 ? (
            <p className="max-w-prose px-6 py-4 text-sm text-white/60 leading-6">
              This instance has no live keys.
            </p>
          ) : null}

          {keys.map((key) => (
            <div
              key={key.id}
              className="flex flex-col gap-2 border-white/[0.06] border-t px-6 py-4 first:border-t-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
            >
              <div className="flex flex-col gap-1">
                <span className="font-medium text-sm text-white/80 tracking-[-0.02em]">
                  {key.name}
                  {key.controlPlane ? (
                    <span className="ml-2 rounded-[40px] border border-white/20 bg-accent-tint px-2 py-0.5 font-normal text-white/80 text-xs">
                      managed by Hogsend Cloud
                    </span>
                  ) : null}
                </span>
                <span className="font-mono text-white/50 text-xs">
                  {key.id}
                </span>
                <span className="text-white/50 text-xs">
                  {key.revokedAt ? "revoked" : "live"}
                </span>
              </div>
              {access.canReveal && !key.revokedAt ? (
                key.controlPlane ? (
                  <span className="max-w-prose text-sm text-white/60 leading-6">
                    This is the key in the snippet above, and Hogsend Cloud
                    still holds a copy of it. Revoking it here would break that
                    snippet and leave the control plane pointing at a dead
                    credential, so it is managed from Studio instead.
                  </span>
                ) : (
                  <RevokeTenantKeyForm
                    environmentId={access.environmentId}
                    keyId={key.id}
                    keyName={key.name}
                  />
                )
              ) : null}
            </div>
          ))}
        </div>

        {access.canReveal ? (
          <>
            <Hairline />
            <div className="px-6 pb-6">
              <CreateTenantKeyForm environmentId={access.environmentId} />
            </div>
          </>
        ) : null}
      </Card>
    </div>
  );
}

/**
 * The web-first signup's missing half.
 *
 * "Point your code at it" assumes code. Someone who signed up on hogsend.com
 * before they had a repo has none, and the dashboard's `EmptyState` cannot
 * tell them — an environment is created WITH the organization, so that state
 * is unreachable for a new signup. This card sits directly under the .env
 * snippet, where the question actually occurs, and is the ONE home for this
 * copy; the welcome email links here rather than repeating it.
 */
function NoRepoCard(): JSX.Element {
  return (
    <AdvancedDisclosure summary="No repo yet?">
      <div className="flex flex-col gap-5 px-6 pt-1 pb-6">
        <p className="max-w-prose text-sm text-white/60 leading-6">
          A Hogsend app is a repository you own — journeys, email templates and
          schema as TypeScript. These four commands make one and ship it here.
        </p>
        <pre className="overflow-x-auto rounded-[10px] border border-white/[0.08] bg-white/[0.03] px-4 py-3 font-mono text-white/80 text-xs leading-6">
          {SCAFFOLD_COMMANDS.join("\n")}
        </pre>
        <p className="max-w-prose text-sm text-white/60 leading-6">
          {PUBLISH_REPLACES_NOTE}
        </p>
      </div>
    </AdvancedDisclosure>
  );
}

/**
 * What a customer sees before their instance is theirs to use.
 *
 * The state, the step and the "we are retrying" promise all come from
 * `deriveProvisionProgress`, which reads the sweeps' own constants — so this
 * card claims a retry only where a sweep would really re-drive, and claims a
 * human only where the alert sweep would really page one.
 */
function ProvisioningCard({
  progress,
  now,
}: {
  progress: ProvisionProgress;
  now: Date;
}): JSX.Element {
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="font-medium text-white tracking-[-0.02em]">
        {progress.state === "ready"
          ? "Finishing your login"
          : "Setting up your instance"}
      </h2>
      {progress.step ? (
        <p className="text-sm text-white/70 leading-6">
          {PROVISION_STEP_LABELS[progress.step]}
          {progress.since ? (
            <>
              {" "}
              — since <TimeAgo at={progress.since} now={now} />
            </>
          ) : null}
          . <span className="font-mono text-white/45">({progress.step})</span>
        </p>
      ) : null}
      <p className="max-w-prose text-sm text-white/60 leading-6">
        {progress.state === "ready"
          ? "Your instance is running, and we are still minting its Studio login. We re-drive that automatically; it appears here when it lands."
          : progress.message}
      </p>
    </Card>
  );
}
