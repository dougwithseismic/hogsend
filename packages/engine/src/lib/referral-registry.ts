import type { DefinedReferral } from "@hogsend/core";

/**
 * Container-held registry of referral definitions, keyed by `DefinedReferral.id`
 * - a structural mirror of {@link AccountLinkProviderRegistry}
 * (`lib/account-link-provider-registry.ts`).
 *
 * There is NO env preset and NO "active referral": a referral is authored in
 * code or it does not exist, and a product may run several programs at once
 * (each link carries its own `links.referral_id`). So an empty registry is the
 * normal state of a deploy that never asked for referrals, and every wired
 * site - the click/arrive touch, the bind at identity adoption, the qualify
 * evaluation in `ingestEvent` - is INERT while it stays empty.
 *
 * Last-writer-wins on `id`, matching every other registry merge in the engine.
 * `defineReferral()` already validates the id charset, so this does not
 * re-validate it (a second copy of that rule is a second place to update).
 */
export class ReferralRegistry {
  private byId = new Map<string, DefinedReferral>();
  /**
   * `qualify.event` → the referrals watching it. Built at construction because
   * `ingestEvent` asks this question on EVERY event: a miss must cost one map
   * lookup, not a scan of every definition.
   */
  private byEvent = new Map<string, DefinedReferral[]>();

  constructor(referrals: DefinedReferral[] = []) {
    for (const referral of referrals) this.register(referral);
  }

  /** Register (or replace) a referral. Last-writer-wins on `id`. */
  register(referral: DefinedReferral): void {
    const id = referral.id;
    if (!id) {
      throw new TypeError(
        "referral has no id - the id keys the registry and is stamped on " +
          "every touch row, so it is required (author referrals with " +
          "defineReferral, which resolves it)",
      );
    }
    const prior = this.byId.get(id);
    if (prior) this.unindexEvent(prior);
    this.byId.set(id, referral);
    const event = referral.meta.qualify?.event;
    if (event) {
      const watchers = this.byEvent.get(event) ?? [];
      watchers.push(referral);
      this.byEvent.set(event, watchers);
    }
  }

  private unindexEvent(referral: DefinedReferral): void {
    const event = referral.meta.qualify?.event;
    if (!event) return;
    const watchers = (this.byEvent.get(event) ?? []).filter(
      (r) => r !== referral,
    );
    if (watchers.length > 0) this.byEvent.set(event, watchers);
    else this.byEvent.delete(event);
  }

  get(id: string): DefinedReferral | undefined {
    return this.byId.get(id);
  }

  list(): DefinedReferral[] {
    return [...this.byId.values()];
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }

  count(): number {
    return this.byId.size;
  }

  /** Every referral whose `qualify.event` is `event`. Empty when none watch it. */
  byQualifyEvent(event: string): DefinedReferral[] {
    return this.byEvent.get(event) ?? [];
  }
}
