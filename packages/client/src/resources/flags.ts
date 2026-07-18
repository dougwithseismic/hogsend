import type { HttpClient } from "../internal/http.js";
import type {
  ArchiveFlagResult,
  CreateFlagInput,
  EvaluateFlagsInput,
  Flag,
  FlagMap,
  UpdateFlagInput,
} from "../types.js";

/**
 * The `flags.*` resource bound to an {@link HttpClient} — the SECRET-KEY-ONLY
 * native feature-flag data plane.
 *
 * - `evaluate` reads the server-evaluated flag map for a contact resolved
 *   server-trusted from `userId`/`email` (`POST /v1/flags/evaluate`, guarded by
 *   a secret key + `ingest` scope).
 * - `list`/`create`/`update`/`archive` are the Studio authoring surface on the
 *   admin plane (`/v1/admin/flags`) and REQUIRE a full-admin `apiKey`.
 *
 * Evaluation is STICKY by construction (a deterministic hash of
 * contactKey+flagKey), so there is no per-user assignment to store.
 */
export class FlagsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Evaluate every flag for a contact and return the served-value map (a
   * boolean flag "on" → `true`; multivariate → the arm's `value`; not-matched
   * or not-in-rollout → the flag's `defaultValue`). Resolve the contact by
   * `userId` (external id) or `email`.
   */
  async evaluate(input: EvaluateFlagsInput): Promise<FlagMap> {
    const identity = input as { userId?: string; email?: string };
    const res = await this.http.post<{ flags: FlagMap }>("/v1/flags/evaluate", {
      userId: identity.userId,
      email: identity.email,
    });
    return res.flags;
  }

  /** List flags, newest-created first (live flags only). Full-admin `apiKey`. */
  async list(): Promise<Flag[]> {
    const res = await this.http.get<{ flags: Flag[] }>("/v1/admin/flags");
    return res.flags;
  }

  /**
   * Create a flag. `key`/`name`/`type` are required. Throws a
   * {@link HogsendAPIError} with `status === 409` when a live flag already owns
   * the key. Full-admin `apiKey`.
   */
  async create(input: CreateFlagInput): Promise<Flag> {
    const res = await this.http.post<{ flag: Flag }>("/v1/admin/flags", {
      key: input.key,
      name: input.name,
      description: input.description,
      enabled: input.enabled,
      type: input.type,
      variants: input.variants,
      defaultValue: input.defaultValue,
      targeting: input.targeting,
      rollout: input.rollout,
    });
    return res.flag;
  }

  /**
   * Update a flag by its `id` (uuid) — toggle `enabled`, edit
   * targeting/rollout/variants, etc. Only the provided fields change; `key` is
   * immutable. Throws `status === 404` for an unknown id. Full-admin `apiKey`.
   */
  async update(id: string, patch: UpdateFlagInput): Promise<Flag> {
    const res = await this.http.patch<{ flag: Flag }>(
      `/v1/admin/flags/${encodeURIComponent(id)}`,
      patch,
    );
    return res.flag;
  }

  /**
   * Archive a flag by its `id` (uuid) — a soft-delete that frees the key for
   * reuse. Throws `status === 404` for an unknown id. Full-admin `apiKey`.
   */
  archive(id: string): Promise<ArchiveFlagResult> {
    return this.http.del<ArchiveFlagResult>(
      `/v1/admin/flags/${encodeURIComponent(id)}`,
    );
  }
}
