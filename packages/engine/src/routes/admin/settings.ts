import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import type { HogsendClient } from "../../container.js";
import {
  deleteOperatorSetting,
  FX_SETTINGS_KEY,
  type FxSetting,
  getOperatorSetting,
  putOperatorSetting,
} from "../../lib/operator-settings.js";

/**
 * Operator settings — the Studio-facing surface over `operator_settings`.
 * Mounted at `/v1/admin/settings`, inheriting `requireAdmin` + `rateLimit` +
 * `auditMiddleware` from the admin router root.
 *
 * Today: `/fx`, the base-currency choice behind the FX lens. The precedence
 * the response makes explicit (mirroring the container's resolver):
 *
 *   - a setting ROW with a currency  → that currency ("set here")
 *   - a setting ROW with null        → lens explicitly OFF (beats env)
 *   - NO row                         → env `BASE_CURRENCY`, else off
 *
 * PUT writes/updates the row (a null body value = the explicit off); DELETE
 * removes the row entirely, falling back to env. Every mutation returns the
 * same full state as GET so the Studio card never needs a second fetch.
 */

const fxStateSchema = z.object({
  // The stored operator choice, or null when no row exists.
  setting: z.object({ baseCurrency: z.string().nullable() }).nullable(),
  // The env bootstrap default (`BASE_CURRENCY`), shown so the card can say
  // where the effective value comes from — and name the static sheet's
  // quoted base when it can't serve the effective one.
  env: z.object({ baseCurrency: z.string().nullable() }),
  // What the lens actually resolves right now (setting ?? env; null = off).
  effective: z.object({ baseCurrency: z.string().nullable() }),
  // The resolved rate source probed against the effective base — null when
  // no provider is configured at all. `servesEffectiveBase: false` with a
  // base set = converted figures will NOT appear (e.g. a USD-quoted static
  // sheet asked for EUR — the honesty rule).
  provider: z
    .object({
      id: z.string(),
      asOf: z.string().nullable(),
      servesEffectiveBase: z.boolean(),
    })
    .nullable(),
});

const putFxBodySchema = z.object({
  baseCurrency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO-4217 code")
    .transform((v) => v.toUpperCase())
    .nullable(),
});

const getFxRoute = createRoute({
  method: "get",
  path: "/fx",
  tags: ["Admin — Settings"],
  summary: "Get the base-currency (FX lens) setting",
  responses: {
    200: {
      content: { "application/json": { schema: fxStateSchema } },
      description:
        "The stored setting, the env default, the effective base, and the rate source probed against it",
    },
  },
});

const putFxRoute = createRoute({
  method: "put",
  path: "/fx",
  tags: ["Admin — Settings"],
  summary: "Set (or explicitly turn off) the base currency",
  description:
    "Upserts the operator's base-currency choice. `baseCurrency: null` is the EXPLICIT off — it beats an env BASE_CURRENCY. To fall back to env instead, DELETE the setting.",
  request: {
    body: {
      content: { "application/json": { schema: putFxBodySchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: fxStateSchema } },
      description: "The updated state (same shape as GET)",
    },
  },
});

const deleteFxRoute = createRoute({
  method: "delete",
  path: "/fx",
  tags: ["Admin — Settings"],
  summary: "Clear the base-currency setting (fall back to env)",
  responses: {
    200: {
      content: { "application/json": { schema: fxStateSchema } },
      description:
        "The state after removing the override (idempotent — 200 even when no row existed)",
    },
  },
});

/** Assemble the full GET-shape state the card needs to be honest. */
async function fxStateOf(container: HogsendClient) {
  const setting = await getOperatorSetting<FxSetting>(
    container.db,
    FX_SETTINGS_KEY,
  );
  const effective = await container.fx.getBaseCurrency();
  // The probe IS getRatesToBase(): it resolves the same effective base per
  // call, so a null sheet with a base set means the source cannot serve it.
  const sheet = effective ? await container.fx.getRatesToBase() : null;
  return {
    setting,
    env: { baseCurrency: container.env.BASE_CURRENCY ?? null },
    effective: { baseCurrency: effective },
    provider: container.fx.providerId
      ? {
          id: container.fx.providerId,
          asOf: sheet?.asOf ?? null,
          servesEffectiveBase: sheet !== null,
        }
      : null,
  };
}

export const settingsRouter = new OpenAPIHono<AppEnv>()
  .openapi(getFxRoute, async (c) => {
    return c.json(await fxStateOf(c.get("container")), 200);
  })
  .openapi(putFxRoute, async (c) => {
    const container = c.get("container");
    const { baseCurrency } = c.req.valid("json");
    await putOperatorSetting(container.db, FX_SETTINGS_KEY, { baseCurrency });
    return c.json(await fxStateOf(container), 200);
  })
  .openapi(deleteFxRoute, async (c) => {
    const container = c.get("container");
    await deleteOperatorSetting(container.db, FX_SETTINGS_KEY);
    return c.json(await fxStateOf(container), 200);
  });
