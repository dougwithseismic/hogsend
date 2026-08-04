import { describe, expect, it } from "vitest";
import {
  type DnsProvider,
  DnsRecordConflictError,
  type DnsRecordHandle,
} from "./types";

/**
 * The implementation-agnostic contract every `DnsProvider` must pass.
 *
 * As with the substrate contract, this suite is the real definition of the
 * seam: the interface fixes the shapes, this fixes the BEHAVIOUR — idempotent
 * create, refuse-to-repoint, forgiving delete. `FakeDns` and `CloudflareDns`
 * (against a mocked transport) run the exact same assertions, which is what
 * makes the fake a safe stand-in everywhere else in the control plane.
 */

export interface DnsContractHarness {
  provider: DnsProvider;
  /**
   * Reset to an empty zone between cases. The seam has no "delete everything",
   * on purpose — that is not an operation any caller should be able to reach.
   */
  reset(): Promise<void>;
}

const HOSTNAME = "acme.hogsend.test";
const TARGET = "stack-abc.example-substrate.test";
const CNAME = { type: "CNAME", hostname: HOSTNAME, value: TARGET };

export function describeDnsContract(
  name: string,
  makeHarness: () => Promise<DnsContractHarness> | DnsContractHarness,
): void {
  describe(`DnsProvider contract: ${name}`, () => {
    async function setup(): Promise<DnsProvider> {
      const harness = await makeHarness();
      await harness.reset();
      return harness.provider;
    }

    it("creates a record and hands back a handle that names it", async () => {
      const provider = await setup();

      const handle = await provider.ensureRecord({
        ...CNAME,
      });

      expect(handle.hostname).toBe(HOSTNAME);
      expect(handle.id).toBeTruthy();
    });

    // The pipeline re-drives a failed step. The second pass runs against a zone
    // the first pass already wrote to, and must be a no-op rather than an error.
    it("is idempotent: the same spec twice returns the same record", async () => {
      const provider = await setup();

      const first = await provider.ensureRecord({
        ...CNAME,
      });
      const second = await provider.ensureRecord({
        ...CNAME,
      });

      expect(second.id).toBe(first.id);
    });

    // The existing record may be another tenant's live instance. Repointing it
    // would take their tracked links and Studio down to resolve our collision.
    it("refuses to repoint a hostname that resolves somewhere else", async () => {
      const provider = await setup();
      await provider.ensureRecord(CNAME);

      await expect(
        provider.ensureRecord({
          type: "CNAME",
          hostname: HOSTNAME,
          value: "somewhere-else.example-substrate.test",
        }),
      ).rejects.toBeInstanceOf(DnsRecordConflictError);
    });

    it("deletes a record, and deleting it again still succeeds", async () => {
      const provider = await setup();
      const handle = await provider.ensureRecord({
        ...CNAME,
      });

      await provider.deleteRecord(handle);
      // Teardown runs more than once. The second pass must not fail on work the
      // first one finished.
      await expect(provider.deleteRecord(handle)).resolves.toBeUndefined();
    });

    it("frees the hostname once the record is deleted", async () => {
      const provider = await setup();
      const handle = await provider.ensureRecord({
        ...CNAME,
      });
      await provider.deleteRecord(handle);

      const reused = await provider.ensureRecord({
        type: "CNAME",
        hostname: HOSTNAME,
        value: "a-different-stack.example-substrate.test",
      });
      expect(reused.hostname).toBe(HOSTNAME);
    });

    it("reports capacity, and counts a created record against it", async () => {
      const provider = await setup();
      const before = await provider.readCapacity();

      await provider.ensureRecord(CNAME);
      const after = await provider.readCapacity();

      expect(after.used).toBe(before.used + 1);
      if (after.limit !== null) {
        expect(after.limit).toBeGreaterThan(0);
      }
    });

    // The behaviour the CNAME-only bug violated: a substrate custom domain
    // needs BOTH records, and they coexist rather than collide.
    it("holds a CNAME and a TXT for one domain at the same time", async () => {
      const provider = await setup();

      const cname = await provider.ensureRecord(CNAME);
      const txt = await provider.ensureRecord({
        type: "TXT",
        hostname: `_verify.${HOSTNAME}`,
        value: "verify=abc123",
      });

      expect(txt.id).not.toBe(cname.id);
      expect((await provider.readCapacity()).used).toBe(2);
    });

    // Same name, different type, is two records — not a conflict. Some
    // platforms put the ownership TXT on the domain itself.
    it("does not confuse a TXT with a CNAME on the same name", async () => {
      const provider = await setup();
      await provider.ensureRecord(CNAME);

      const txt = await provider.ensureRecord({
        type: "TXT",
        hostname: HOSTNAME,
        value: "verify=abc123",
      });

      expect(txt.type).toBe("TXT");
      expect((await provider.readCapacity()).used).toBe(2);
    });

    it("deleting an id it never issued is not an error", async () => {
      const provider = await setup();
      const stranger: Pick<DnsRecordHandle, "id"> = { id: "no-such-record" };

      await expect(provider.deleteRecord(stranger)).resolves.toBeUndefined();
    });
  });
}
