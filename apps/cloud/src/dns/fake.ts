import {
  type DnsCapacity,
  type DnsProvider,
  DnsRecordConflictError,
  type DnsRecordHandle,
  type DnsRecordSpec,
} from "./types";

/**
 * The in-memory DNS provider: every test, and local dev.
 *
 * Deterministic on purpose. Record ids are a counter rather than a random
 * string, so a failing assertion names the same id on every run and a snapshot
 * of a provisioned stack is reproducible.
 *
 * It enforces the SAME refusals the real one does — the conflict on a
 * repointed hostname above all — because a fake that is merely permissive
 * would let a bug through every test in the control plane and surface only in
 * production.
 */
export const FAKE_DNS_ID = "fake";

/** Mirrors a Cloudflare Free zone, so dev meets the real ceiling. */
const FAKE_RECORD_LIMIT = 200;

interface FakeRecord {
  id: string;
  hostname: string;
  target: string;
}

export class FakeDns implements DnsProvider {
  readonly id = FAKE_DNS_ID;

  private readonly records = new Map<string, FakeRecord>();
  private counter = 0;

  async ensureRecord(spec: DnsRecordSpec): Promise<DnsRecordHandle> {
    const existing = this.find(spec.hostname);
    if (existing) {
      if (existing.target !== spec.target) {
        throw new DnsRecordConflictError(spec.hostname, existing.target);
      }
      return { id: existing.id, hostname: existing.hostname };
    }

    this.counter += 1;
    const record: FakeRecord = {
      id: `fake-dns-${this.counter}`,
      hostname: spec.hostname,
      target: spec.target,
    };
    this.records.set(record.id, record);
    return { id: record.id, hostname: record.hostname };
  }

  async deleteRecord(handle: Pick<DnsRecordHandle, "id">): Promise<void> {
    // Absent is a success, not a miss: teardown re-runs.
    this.records.delete(handle.id);
  }

  async readCapacity(): Promise<DnsCapacity> {
    return { used: this.records.size, limit: FAKE_RECORD_LIMIT };
  }

  /** Test helper. Not on the seam — no caller may empty a real zone. */
  async reset(): Promise<void> {
    this.records.clear();
    this.counter = 0;
  }

  private find(hostname: string): FakeRecord | undefined {
    for (const record of this.records.values()) {
      if (record.hostname === hostname) return record;
    }
    return undefined;
  }
}
