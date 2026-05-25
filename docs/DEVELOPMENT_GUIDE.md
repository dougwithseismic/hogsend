# Hogsend — Development Guide

Implementation guide for the journey engine. Each phase builds on the previous. Follow in order.

---

## What We're Building

A code-first lifecycle engine that takes events in (PostHog webhooks, internal API calls), walks users through typed journey state machines, and pushes actions out (emails via Resend, webhooks, PostHog events). Think Customer.io for engineers who'd rather write TypeScript than drag boxes on a canvas.

**Key design decision:** We use [Hatchet](https://hatchet.run) for durable workflow execution instead of building a custom state machine + scheduler. This eliminates ~40 files of hand-rolled orchestration code and gives us retries, crash recovery, observability, and durable sleeps for free.

**What Hatchet handles:**
- Durable execution (workflow runs survive crashes/restarts)
- Sleep/delay between steps (`ctx.sleepFor('48h')`)
- Retries with backoff on failures
- Concurrency control
- Run history and observability dashboard

**What we build custom:**
- Journey definitions (TypeScript DSL)
- Journey registry (load + validate definitions at startup)
- Condition evaluators (property checks, event checks, email engagement)
- Event ingestion + enrollment logic
- Email pipeline (React Email + Resend + link rewriting + tracking)
- Tracking endpoints (/track/open, /track/click, /unsubscribe)

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    Event Sources                      │
│  PostHog webhooks ─┐                                  │
│  Internal events ──┤──→ Hono Ingestion (/v1/ingest)   │
│  API calls ────────┘         │                        │
└──────────────────────────────┼────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────┐
│                   Journey Engine                      │
│                                                       │
│  ┌─────────────┐  ┌──────────────┐                    │
│  │  Enrollment  │  │   Hatchet    │                    │
│  │  (match      │  │  (durable    │                    │
│  │   trigger,   │  │   workflow   │                    │
│  │   check      │  │   execution, │                    │
│  │   limits,    │  │   sleeps,    │                    │
│  │   kick off   │  │   retries,   │                    │
│  │   workflow)  │  │   dashboard) │                    │
│  └──────┬──────┘  └──────┬───────┘                    │
│         └────────────────┼                            │
│                          ▼                            │
│                   Action Router                       │
└──────────────────────┬───────────────────────────────┘
                       │
          ┌────────────┼────────────┬──────────────┐
          ▼            ▼            ▼              ▼
   ┌──────────┐ ┌──────────┐ ┌──────────┐  ┌──────────┐
   │  Resend  │ │ PostHog  │ │ Webhook  │  │  Enroll  │
   │  Email   │ │  Event   │ │  (HTTP)  │  │  Another │
   │  Send    │ │  Push    │ │          │  │  Journey │
   └────┬─────┘ └──────────┘ └──────────┘  └──────────┘
        │
   ┌────┴─────────────────────────────────┐
   │         Email Pipeline               │
   │  React Email render                  │
   │  → Link rewrite (tracking URLs)      │
   │  → Open pixel inject                 │
   │  → Resend API send                   │
   └──────────────────────────────────────┘
```

### Monorepo Layout

```
growthhog/
  apps/
    api/                     ← Hono HTTP layer + Hatchet worker
      src/
        journeys/            ← Journey definitions (TypeScript objects)
        workflows/           ← Hatchet workflow implementations
  packages/
    db/                      ← Drizzle ORM schemas, migrations, connection
    journey-engine/          ← Types, registry, conditions, action helpers
```

**Key technology choices:**
- **Hatchet** — Durable workflow execution. Self-hosted via Docker, TypeScript SDK.
- **Drizzle ORM** — TypeScript-first schema, raw SQL escape hatches
- **postgres.js** — ESM-native Postgres driver
- **Resend** — Email delivery (Phase 6)
- **React Email** — Email templates (Phase 6)
- **Zod 4** — Runtime validation of journey definitions and API inputs

---

## Prerequisites

- Docker running (for TimescaleDB + Redis + Hatchet)
- Node.js >= 22
- pnpm 9+

---

## Phase 1: Infrastructure + Database

### 1.1 Add Hatchet to Docker Compose

Update `docker-compose.yml` to add Hatchet Lite (bundles engine + dashboard in one container):

```yaml
services:
  postgres:
    image: timescale/timescaledb:latest-pg18
    restart: unless-stopped
    environment:
      POSTGRES_USER: growthhog
      POSTGRES_PASSWORD: growthhog
      POSTGRES_DB: growthhog
    ports:
      - "5434:5432"
    volumes:
      - pgdata:/home/postgres/pgdata/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U growthhog"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:8-alpine
    restart: unless-stopped
    ports:
      - "6380:6379"
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

  hatchet-db:
    image: postgres:15.6
    command: postgres -c 'max_connections=200'
    restart: unless-stopped
    environment:
      POSTGRES_USER: hatchet
      POSTGRES_PASSWORD: hatchet
      POSTGRES_DB: hatchet
    volumes:
      - hatchet_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -d hatchet -U hatchet"]
      interval: 10s
      timeout: 10s
      retries: 5
      start_period: 10s

  hatchet:
    image: ghcr.io/hatchet-dev/hatchet/hatchet-lite:latest
    ports:
      - "8888:8888"
      - "7077:7077"
    depends_on:
      hatchet-db:
        condition: service_healthy
    environment:
      DATABASE_URL: "postgresql://hatchet:hatchet@hatchet-db:5432/hatchet?sslmode=disable"
      SERVER_AUTH_COOKIE_DOMAIN: localhost
      SERVER_AUTH_COOKIE_INSECURE: "t"
      SERVER_GRPC_BIND_ADDRESS: "0.0.0.0"
      SERVER_GRPC_INSECURE: "t"
      SERVER_GRPC_BROADCAST_ADDRESS: localhost:7077
      SERVER_GRPC_PORT: "7077"
      SERVER_URL: http://localhost:8888
      SERVER_AUTH_SET_EMAIL_VERIFIED: "t"
      SERVER_DEFAULT_ENGINE_VERSION: "V1"
      SERVER_INTERNAL_CLIENT_INTERNAL_GRPC_BROADCAST_ADDRESS: localhost:7077
    volumes:
      - hatchet_config:/config

volumes:
  pgdata:
  redisdata:
  hatchet_pgdata:
  hatchet_config:
```

Hatchet gets its own Postgres instance (separate from your app data). After `docker compose up -d`, the Hatchet dashboard is at `http://localhost:8888` — login with `admin@example.com` / `Admin123!!`. Generate an API token from Settings > API Tokens.

### 1.2 Database Schemas (Already Exist)

The `packages/db` package already has the core schemas. Here's the current state and what needs updating:

| Table | Status | Notes |
|-------|--------|-------|
| `journey_states` | Needs update | Add `hatchetRunId`, `userEmail`, `journeyNodeId` aliased from `currentNodeId` |
| `journey_logs` | OK | Already has FK to journey_states, action, detail |
| `email_sends` | Needs update | Add `templateKey`, `clickedAt`, `bouncedAt`, `complainedAt` for tracking |
| `tracked_links` | OK | |
| `link_clicks` | OK | |
| `email_preferences` | Needs update | Add `suppressed`, `bounceCount` for hard suppression |
| `user_events` | OK | |

**Key schema change — `journey_states`:**

With Hatchet managing execution state, `journey_states` becomes a lightweight enrollment record. The critical addition is `hatchetRunId` to link your domain state to the Hatchet workflow run:

```typescript
// packages/db/src/schema/journey-states.ts
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { journeyStatusEnum } from "./enums.js";

export const journeyStates = pgTable(
  "journey_states",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    userEmail: text("user_email").notNull(),
    journeyId: text("journey_id").notNull(),
    currentNodeId: text("current_node_id").notNull(),
    status: journeyStatusEnum("status").notNull().default("active"),
    hatchetRunId: text("hatchet_run_id"),
    context: jsonb("context").$type<Record<string, unknown>>().default({}),
    errorMessage: text("error_message"),
    entryCount: integer("entry_count").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_user_journey_active").on(
      table.userId,
      table.journeyId,
      table.status,
    ),
    index("journey_states_status_idx").on(table.status),
    index("journey_states_hatchet_run_idx").on(table.hatchetRunId),
  ],
);
```

### 1.3 Generate and Run Migrations

```bash
docker compose up -d

DATABASE_URL="postgresql://growthhog:growthhog@localhost:5434/growthhog" \
  pnpm --filter @growthhog/db db:generate

DATABASE_URL="postgresql://growthhog:growthhog@localhost:5434/growthhog" \
  pnpm --filter @growthhog/db db:migrate
```

### 1.4 Environment Variables

Add to `apps/api/.env`:

```bash
HATCHET_CLIENT_TOKEN="<token-from-hatchet-dashboard>"
HATCHET_CLIENT_TLS_STRATEGY=none
```

Update `apps/api/src/env.ts` to validate the new vars:

```typescript
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const API_VERSION = "0.0.1";

export const env = createEnv({
  server: {
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    PORT: z.coerce.number().default(3002),
    LOG_LEVEL: z
      .enum(["error", "warn", "info", "http", "debug"])
      .default("info"),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
    BETTER_AUTH_SECRET: z.string().min(1),
    BETTER_AUTH_URL: z.string().url().default("http://localhost:3002"),
    HATCHET_CLIENT_TOKEN: z.string().min(1),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
```

### 1.5 Verify Phase 1

```bash
docker compose up -d

# Hatchet dashboard should be at http://localhost:8888
# Login: admin@example.com / Admin123!!

# Run migrations
DATABASE_URL="postgresql://growthhog:growthhog@localhost:5434/growthhog" \
  pnpm --filter @growthhog/db db:migrate

# Start the API (should boot without errors)
pnpm --filter @growthhog/api dev
```

---

## Phase 2: Journey Type System + Registry

### 2.1 Create the `packages/journey-engine` Package

```
packages/journey-engine/
  package.json
  tsconfig.json
  src/
    index.ts
    types/
      index.ts
      journey.ts
      nodes.ts
      actions.ts
      conditions.ts
    schemas/
      index.ts
      journey.schema.ts
    registry/
      index.ts
    conditions/
      index.ts
      evaluate.ts
      property.ts
      event.ts
      email-engagement.ts
      composite.ts
```

Install deps:

```bash
mkdir -p packages/journey-engine/src/{types,schemas,registry,conditions}

# Initialize package.json, then:
pnpm --filter @growthhog/journey-engine add @growthhog/db@workspace:* zod@latest
pnpm --filter @growthhog/journey-engine add -D @repo/typescript-config@workspace:* @types/node@latest tsx@latest
```

#### `packages/journey-engine/package.json`

```json
{
  "name": "@growthhog/journey-engine",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./types": "./src/types/index.ts",
    "./registry": "./src/registry/index.ts",
    "./conditions": "./src/conditions/index.ts",
    "./schemas": "./src/schemas/index.ts"
  },
  "scripts": {
    "check-types": "tsc --noEmit"
  },
  "dependencies": {
    "@growthhog/db": "workspace:*",
    "zod": "latest"
  },
  "devDependencies": {
    "@repo/typescript-config": "workspace:*",
    "@types/node": "latest",
    "tsx": "latest"
  }
}
```

#### `packages/journey-engine/tsconfig.json`

```json
{
  "extends": "@repo/typescript-config/base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

### 2.2 Type Definitions

These define the journey DSL. They're runtime types used throughout the engine.

#### `packages/journey-engine/src/types/index.ts`

```typescript
export * from "./journey.js";
export * from "./nodes.js";
export * from "./actions.js";
export * from "./conditions.js";
```

#### `packages/journey-engine/src/types/conditions.ts`

```typescript
export interface PropertyCondition {
  type: "property";
  property: string;
  operator:
    | "eq"
    | "neq"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "exists"
    | "not_exists"
    | "contains";
  value?: string | number | boolean;
}

export interface EventCondition {
  type: "event";
  eventName: string;
  check: "exists" | "not_exists" | "count";
  operator?: "gt" | "gte" | "lt" | "lte" | "eq";
  value?: number;
  withinHours?: number;
}

export interface EmailEngagementCondition {
  type: "email_engagement";
  templateKey: string;
  check: "opened" | "clicked" | "not_opened" | "not_clicked";
}

export interface CompositeCondition {
  type: "composite";
  operator: "and" | "or";
  conditions: ConditionEval[];
}

export type ConditionEval =
  | PropertyCondition
  | EventCondition
  | EmailEngagementCondition
  | CompositeCondition;
```

#### `packages/journey-engine/src/types/actions.ts`

```typescript
export interface SendEmailAction {
  type: "send_email";
  templateKey: string;
  subject: string;
  category?: string;
}

export interface FireEventAction {
  type: "fire_event";
  eventName: string;
  properties?: Record<string, unknown>;
}

export interface WebhookAction {
  type: "webhook";
  url: string;
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface EnrollJourneyAction {
  type: "enroll_journey";
  journeyId: string;
}

export type JourneyAction =
  | SendEmailAction
  | FireEventAction
  | WebhookAction
  | EnrollJourneyAction;
```

#### `packages/journey-engine/src/types/nodes.ts`

```typescript
import type { JourneyAction } from "./actions.js";
import type { ConditionEval } from "./conditions.js";

export interface ActionNode {
  type: "action";
  id: string;
  action: JourneyAction;
  next: string | null;
}

export interface WaitNode {
  type: "wait";
  id: string;
  hours: number;
  next: string;
}

export interface ConditionNode {
  type: "condition";
  id: string;
  eval: ConditionEval;
  onTrue: string;
  onFalse: string;
}

export type JourneyNode = ActionNode | WaitNode | ConditionNode;
```

#### `packages/journey-engine/src/types/journey.ts`

```typescript
import type { JourneyNode } from "./nodes.js";
import type { PropertyCondition } from "./conditions.js";

export interface JourneyDefinition {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;

  trigger: {
    event: string;
    where?: PropertyCondition[];
  };

  entryLimit: "once" | "once_per_period" | "unlimited";
  entryPeriodHours?: number;

  exitOn?: Array<{
    event: string;
    where?: PropertyCondition[];
  }>;

  suppressHours: number;

  entryNode: string;

  nodes: Record<string, JourneyNode>;
}
```

### 2.3 Zod Validation Schemas

Validates journey definitions at load time. Typos and invalid structures fail loudly at startup.

#### `packages/journey-engine/src/schemas/index.ts`

```typescript
export { journeyDefinitionSchema } from "./journey.schema.js";
```

#### `packages/journey-engine/src/schemas/journey.schema.ts`

```typescript
import { z } from "zod";

const propertyConditionSchema = z.object({
  type: z.literal("property"),
  property: z.string(),
  operator: z.enum([
    "eq", "neq", "gt", "gte", "lt", "lte", "exists", "not_exists", "contains",
  ]),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const eventConditionSchema = z.object({
  type: z.literal("event"),
  eventName: z.string(),
  check: z.enum(["exists", "not_exists", "count"]),
  operator: z.enum(["gt", "gte", "lt", "lte", "eq"]).optional(),
  value: z.number().optional(),
  withinHours: z.number().positive().optional(),
});

const emailEngagementConditionSchema = z.object({
  type: z.literal("email_engagement"),
  templateKey: z.string(),
  check: z.enum(["opened", "clicked", "not_opened", "not_clicked"]),
});

const conditionEvalSchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion("type", [
    propertyConditionSchema,
    eventConditionSchema,
    emailEngagementConditionSchema,
    z.object({
      type: z.literal("composite"),
      operator: z.enum(["and", "or"]),
      conditions: z.array(conditionEvalSchema),
    }),
  ]),
);

const sendEmailActionSchema = z.object({
  type: z.literal("send_email"),
  templateKey: z.string(),
  subject: z.string(),
  category: z.string().optional(),
});

const fireEventActionSchema = z.object({
  type: z.literal("fire_event"),
  eventName: z.string(),
  properties: z.record(z.unknown()).optional(),
});

const webhookActionSchema = z.object({
  type: z.literal("webhook"),
  url: z.string().url(),
  method: z.enum(["POST", "PUT"]).optional(),
  headers: z.record(z.string()).optional(),
  body: z.record(z.unknown()).optional(),
});

const enrollJourneyActionSchema = z.object({
  type: z.literal("enroll_journey"),
  journeyId: z.string(),
});

const journeyActionSchema = z.discriminatedUnion("type", [
  sendEmailActionSchema,
  fireEventActionSchema,
  webhookActionSchema,
  enrollJourneyActionSchema,
]);

const actionNodeSchema = z.object({
  type: z.literal("action"),
  id: z.string(),
  action: journeyActionSchema,
  next: z.string().nullable(),
});

const waitNodeSchema = z.object({
  type: z.literal("wait"),
  id: z.string(),
  hours: z.number().positive(),
  next: z.string(),
});

const conditionNodeSchema = z.object({
  type: z.literal("condition"),
  id: z.string(),
  eval: conditionEvalSchema,
  onTrue: z.string(),
  onFalse: z.string(),
});

const journeyNodeSchema = z.discriminatedUnion("type", [
  actionNodeSchema,
  waitNodeSchema,
  conditionNodeSchema,
]);

export const journeyDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean(),

  trigger: z.object({
    event: z.string().min(1),
    where: z.array(propertyConditionSchema).optional(),
  }),

  entryLimit: z.enum(["once", "once_per_period", "unlimited"]),
  entryPeriodHours: z.number().positive().optional(),

  exitOn: z
    .array(
      z.object({
        event: z.string().min(1),
        where: z.array(propertyConditionSchema).optional(),
      }),
    )
    .optional(),

  suppressHours: z.number().min(0),
  entryNode: z.string().min(1),
  nodes: z.record(z.string(), journeyNodeSchema),
});
```

### 2.4 Journey Registry

Runtime container for loaded journey definitions. Provides fast lookups by trigger event and journey ID.

#### `packages/journey-engine/src/registry/index.ts`

```typescript
import type { JourneyDefinition } from "../types/index.js";
import { journeyDefinitionSchema } from "../schemas/index.js";

export class JourneyRegistry {
  private journeys: Map<string, JourneyDefinition> = new Map();
  private triggerIndex: Map<string, JourneyDefinition[]> = new Map();

  register(journey: JourneyDefinition): void {
    const parsed = journeyDefinitionSchema.parse(journey);
    const validated = parsed as unknown as JourneyDefinition;

    this.journeys.set(validated.id, validated);

    const event = validated.trigger.event;
    const existing = this.triggerIndex.get(event) ?? [];
    existing.push(validated);
    this.triggerIndex.set(event, existing);
  }

  get(id: string): JourneyDefinition | undefined {
    return this.journeys.get(id);
  }

  getByTriggerEvent(eventName: string): JourneyDefinition[] {
    return this.triggerIndex.get(eventName) ?? [];
  }

  getAll(): JourneyDefinition[] {
    return Array.from(this.journeys.values());
  }

  getEnabled(): JourneyDefinition[] {
    return this.getAll().filter((j) => j.enabled);
  }

  has(id: string): boolean {
    return this.journeys.has(id);
  }

  count(): number {
    return this.journeys.size;
  }
}
```

### 2.5 Condition Evaluators

Domain-specific logic for evaluating journey conditions. Called from within Hatchet workflow steps.

#### `packages/journey-engine/src/conditions/index.ts`

```typescript
export { evaluateCondition, type ConditionContext } from "./evaluate.js";
```

#### `packages/journey-engine/src/conditions/evaluate.ts`

```typescript
import type { Database } from "@growthhog/db";
import type { ConditionEval } from "../types/index.js";
import { evaluatePropertyCondition } from "./property.js";
import { evaluateEventCondition } from "./event.js";
import { evaluateEmailEngagementCondition } from "./email-engagement.js";
import { evaluateCompositeCondition } from "./composite.js";

export interface ConditionContext {
  db: Database;
  userId: string;
  journeyContext: Record<string, unknown>;
}

export async function evaluateCondition(
  condition: ConditionEval,
  ctx: ConditionContext,
): Promise<boolean> {
  switch (condition.type) {
    case "property":
      return evaluatePropertyCondition(condition, ctx);
    case "event":
      return evaluateEventCondition(condition, ctx);
    case "email_engagement":
      return evaluateEmailEngagementCondition(condition, ctx);
    case "composite":
      return evaluateCompositeCondition(condition, ctx);
    default:
      return false;
  }
}
```

#### `packages/journey-engine/src/conditions/property.ts`

```typescript
import type { PropertyCondition } from "../types/index.js";
import type { ConditionContext } from "./evaluate.js";

export function evaluatePropertyCondition(
  condition: PropertyCondition,
  ctx: ConditionContext,
): boolean {
  const value = ctx.journeyContext[condition.property];
  return compareValue(value, condition.operator, condition.value);
}

function compareValue(
  actual: unknown,
  operator: PropertyCondition["operator"],
  expected: PropertyCondition["value"],
): boolean {
  switch (operator) {
    case "eq": return actual === expected;
    case "neq": return actual !== expected;
    case "gt": return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "gte": return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "lt": return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "lte": return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "exists": return actual !== undefined && actual !== null;
    case "not_exists": return actual === undefined || actual === null;
    case "contains": return typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
    default: return false;
  }
}
```

#### `packages/journey-engine/src/conditions/event.ts`

```typescript
import { eq, and, gte, sql } from "drizzle-orm";
import { userEvents } from "@growthhog/db/schema";
import type { EventCondition } from "../types/index.js";
import type { ConditionContext } from "./evaluate.js";

export async function evaluateEventCondition(
  condition: EventCondition,
  ctx: ConditionContext,
): Promise<boolean> {
  const [result] = await ctx.db
    .select({ count: sql<number>`count(*)` })
    .from(userEvents)
    .where(
      and(
        eq(userEvents.userId, ctx.userId),
        eq(userEvents.event, condition.eventName),
        condition.withinHours
          ? gte(
              userEvents.occurredAt,
              new Date(Date.now() - condition.withinHours * 60 * 60 * 1000),
            )
          : undefined,
      ),
    );

  const count = Number(result?.count ?? 0);

  switch (condition.check) {
    case "exists": return count > 0;
    case "not_exists": return count === 0;
    case "count": {
      if (!condition.operator || condition.value === undefined) return count > 0;
      switch (condition.operator) {
        case "gt": return count > condition.value;
        case "gte": return count >= condition.value;
        case "lt": return count < condition.value;
        case "lte": return count <= condition.value;
        case "eq": return count === condition.value;
        default: return false;
      }
    }
    default: return false;
  }
}
```

#### `packages/journey-engine/src/conditions/email-engagement.ts`

```typescript
import { eq, and } from "drizzle-orm";
import { emailSends } from "@growthhog/db/schema";
import type { EmailEngagementCondition } from "../types/index.js";
import type { ConditionContext } from "./evaluate.js";

export async function evaluateEmailEngagementCondition(
  condition: EmailEngagementCondition,
  ctx: ConditionContext,
): Promise<boolean> {
  // TODO: requires templateKey column on email_sends — add in schema update
  // For now, return false (condition not evaluable)
  return false;
}
```

#### `packages/journey-engine/src/conditions/composite.ts`

```typescript
import type { CompositeCondition } from "../types/index.js";
import type { ConditionContext } from "./evaluate.js";
import { evaluateCondition } from "./evaluate.js";

export async function evaluateCompositeCondition(
  condition: CompositeCondition,
  ctx: ConditionContext,
): Promise<boolean> {
  if (condition.operator === "and") {
    for (const sub of condition.conditions) {
      if (!(await evaluateCondition(sub, ctx))) return false;
    }
    return true;
  }

  if (condition.operator === "or") {
    for (const sub of condition.conditions) {
      if (await evaluateCondition(sub, ctx)) return true;
    }
    return false;
  }

  return false;
}
```

### 2.6 Barrel Export

#### `packages/journey-engine/src/index.ts`

```typescript
export * from "./types/index.js";
export { journeyDefinitionSchema } from "./schemas/index.js";
export { JourneyRegistry } from "./registry/index.js";
export { evaluateCondition, type ConditionContext } from "./conditions/index.js";
```

### 2.7 First Journey Definition

Lives in the API app (journeys are deployment-specific).

#### `apps/api/src/journeys/activation-welcome.ts`

```typescript
import type { JourneyDefinition } from "@growthhog/journey-engine/types";

export const activationWelcome: JourneyDefinition = {
  id: "activation-welcome",
  name: "Activation — Welcome Series",
  enabled: true,

  trigger: { event: "user.created" },
  entryLimit: "once",
  suppressHours: 12,
  exitOn: [{ event: "user.deleted" }],

  entryNode: "send_welcome",

  nodes: {
    send_welcome: {
      type: "action",
      id: "send_welcome",
      action: {
        type: "send_email",
        templateKey: "activation/welcome",
        subject: "Welcome to GrowthHog — let's get you set up",
      },
      next: "wait_48h",
    },

    wait_48h: {
      type: "wait",
      id: "wait_48h",
      hours: 48,
      next: "check_engagement",
    },

    check_engagement: {
      type: "condition",
      id: "check_engagement",
      eval: {
        type: "event",
        eventName: "feature.used",
        check: "exists",
      },
      onTrue: "send_advanced",
      onFalse: "send_nudge",
    },

    send_advanced: {
      type: "action",
      id: "send_advanced",
      action: {
        type: "send_email",
        templateKey: "activation/advanced",
        subject: "Nice work — here's what to try next",
      },
      next: "wait_48h_2",
    },

    send_nudge: {
      type: "action",
      id: "send_nudge",
      action: {
        type: "send_email",
        templateKey: "activation/nudge",
        subject: "You haven't tried the key feature yet",
      },
      next: "wait_48h_2",
    },

    wait_48h_2: {
      type: "wait",
      id: "wait_48h_2",
      hours: 48,
      next: "send_community",
    },

    send_community: {
      type: "action",
      id: "send_community",
      action: {
        type: "send_email",
        templateKey: "activation/community",
        subject: "Join the community",
      },
      next: null,
    },
  },
};
```

#### `apps/api/src/journeys/index.ts`

```typescript
import { JourneyRegistry } from "@growthhog/journey-engine/registry";
import { activationWelcome } from "./activation-welcome.js";

export function createJourneyRegistry(): JourneyRegistry {
  const registry = new JourneyRegistry();

  registry.register(activationWelcome);

  return registry;
}
```

### 2.8 Wire Registry into Container

Update `apps/api/src/container.ts`:

```typescript
import {
  createDatabase,
  type Database,
  type DatabaseClient,
} from "@growthhog/db";
import type { JourneyRegistry } from "@growthhog/journey-engine/registry";
import { env } from "./env.js";
import { createJourneyRegistry } from "./journeys/index.js";
import { type Auth, createAuth } from "./lib/auth.js";
import { createLogger, type Logger } from "./lib/logger.js";

export interface Container {
  env: typeof env;
  logger: Logger;
  db: Database;
  dbClient: DatabaseClient;
  auth: Auth;
  registry: JourneyRegistry;
}

export function createContainer(): Container {
  const logger = createLogger(env.LOG_LEVEL);
  const { db, client } = createDatabase(env.DATABASE_URL);
  const auth = createAuth(db, {
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
  });
  const registry = createJourneyRegistry();

  logger.info(`Journey registry loaded: ${registry.count()} journeys`);

  return {
    env,
    logger,
    db,
    dbClient: client,
    auth,
    registry,
  };
}
```

### 2.9 Verify Phase 2

```bash
pnpm --filter @growthhog/journey-engine check-types
pnpm --filter @growthhog/api check-types

# Start the API — should log "Journey registry loaded: 1 journeys"
pnpm --filter @growthhog/api dev
```

---

## Phase 3: Hatchet Workflow + Event Ingestion

This is where Hatchet replaces the hand-rolled engine. We define a generic "journey runner" workflow that can execute any journey definition.

### 3.1 Install Hatchet SDK

```bash
pnpm --filter @growthhog/api add @hatchet-dev/typescript-sdk@latest
```

### 3.2 Hatchet Client

#### `apps/api/src/lib/hatchet.ts`

```typescript
import { HatchetClient } from "@hatchet-dev/typescript-sdk/v1";

export const hatchet = HatchetClient.init();
```

The SDK reads `HATCHET_CLIENT_TOKEN` and `HATCHET_CLIENT_TLS_STRATEGY` from env automatically.

### 3.3 Journey Runner Workflow

This is the core: a single durable task that can execute any journey definition by walking its node graph. Hatchet provides the durable execution (crash recovery, sleeps, retries).

#### `apps/api/src/workflows/journey-runner.ts`

```typescript
import { eq } from "drizzle-orm";
import { journeyStates, journeyLogs, emailSends, userEvents } from "@growthhog/db/schema";
import { evaluateCondition } from "@growthhog/journey-engine/conditions";
import type { JourneyDefinition, JourneyNode, JourneyAction } from "@growthhog/journey-engine/types";
import { hatchet } from "../lib/hatchet.js";
import { createDatabase } from "@growthhog/db";
import { env } from "../env.js";
import { JourneyRegistry } from "@growthhog/journey-engine/registry";
import { createJourneyRegistry } from "../journeys/index.js";

export interface JourneyRunInput {
  userId: string;
  userEmail: string;
  journeyId: string;
  stateId: string;
  context: Record<string, unknown>;
}

const MAX_NODES = 50;

export const journeyRunner = hatchet.durableTask({
  name: "journey-runner",
  executionTimeout: "30d",
  retries: 3,
  fn: async (input: JourneyRunInput, ctx) => {
    const { db } = createDatabase(env.DATABASE_URL);
    const registry = createJourneyRegistry();

    const journey = registry.get(input.journeyId);
    if (!journey) {
      await markError(db, input.stateId, `Journey '${input.journeyId}' not found`);
      return { error: "journey_not_found" };
    }

    let currentNodeId = journey.entryNode;
    let nodesProcessed = 0;

    while (currentNodeId && nodesProcessed < MAX_NODES) {
      const node = journey.nodes[currentNodeId];
      if (!node) {
        await markError(db, input.stateId, `Node '${currentNodeId}' not found`);
        return { error: "node_not_found", node: currentNodeId };
      }

      await updateCurrentNode(db, input.stateId, currentNodeId);

      const nextNodeId = await processNode(db, node, journey, input, ctx);
      nodesProcessed++;

      await logTransition(db, input.stateId, currentNodeId, nextNodeId, node.type);

      if (nextNodeId === null) {
        await markComplete(db, input.stateId);
        return { completed: true, nodesProcessed };
      }

      currentNodeId = nextNodeId;
    }

    return { completed: false, nodesProcessed, hitLimit: nodesProcessed >= MAX_NODES };
  },
});

async function processNode(
  db: ReturnType<typeof createDatabase>["db"],
  node: JourneyNode,
  journey: JourneyDefinition,
  input: JourneyRunInput,
  ctx: any,
): Promise<string | null> {
  switch (node.type) {
    case "wait":
      await ctx.sleepFor(`${node.hours}h`);
      return node.next;

    case "condition": {
      const result = await evaluateCondition(node.eval, {
        db,
        userId: input.userId,
        journeyContext: input.context,
      });
      return result ? node.onTrue : node.onFalse;
    }

    case "action": {
      await executeAction(db, node.action, input);
      return node.next;
    }

    default:
      return null;
  }
}

async function executeAction(
  db: ReturnType<typeof createDatabase>["db"],
  action: JourneyAction,
  input: JourneyRunInput,
): Promise<void> {
  switch (action.type) {
    case "send_email":
      // Stub: record intent. Real Resend integration in Phase 6.
      await db.insert(emailSends).values({
        journeyStateId: input.stateId,
        fromEmail: "noreply@growthhog.com",
        toEmail: input.userEmail,
        subject: action.subject,
        status: "queued",
      });
      break;

    case "fire_event":
      await db.insert(userEvents).values({
        userId: input.userId,
        event: action.eventName,
        properties: action.properties ?? {},
      });
      break;

    case "webhook": {
      const method = action.method ?? "POST";
      const body = action.body ? JSON.stringify(action.body) : undefined;
      await fetch(action.url, {
        method,
        headers: { "Content-Type": "application/json", ...(action.headers ?? {}) },
        body,
      });
      break;
    }

    case "enroll_journey":
      // Handled by the ingestion layer — fire an internal event
      // that triggers enrollment in the target journey
      break;
  }
}

async function updateCurrentNode(
  db: ReturnType<typeof createDatabase>["db"],
  stateId: string,
  nodeId: string,
): Promise<void> {
  await db
    .update(journeyStates)
    .set({ currentNodeId: nodeId, updatedAt: new Date() })
    .where(eq(journeyStates.id, stateId));
}

async function logTransition(
  db: ReturnType<typeof createDatabase>["db"],
  stateId: string,
  fromNode: string,
  toNode: string | null,
  action: string,
): Promise<void> {
  await db.insert(journeyLogs).values({
    journeyStateId: stateId,
    fromNodeId: fromNode,
    toNodeId: toNode,
    action,
  });
}

async function markComplete(
  db: ReturnType<typeof createDatabase>["db"],
  stateId: string,
): Promise<void> {
  await db
    .update(journeyStates)
    .set({ status: "completed", updatedAt: new Date() })
    .where(eq(journeyStates.id, stateId));
}

async function markError(
  db: ReturnType<typeof createDatabase>["db"],
  stateId: string,
  message: string,
): Promise<void> {
  await db
    .update(journeyStates)
    .set({ status: "failed", errorMessage: message, updatedAt: new Date() })
    .where(eq(journeyStates.id, stateId));
}
```

### 3.4 Hatchet Worker

The worker runs alongside the API (or as a separate process). It picks up workflow runs from Hatchet and executes them.

#### `apps/api/src/worker.ts`

```typescript
import { hatchet } from "./lib/hatchet.js";
import { journeyRunner } from "./workflows/journey-runner.js";

async function main() {
  const worker = await hatchet.worker("journey-worker", {
    workflows: [journeyRunner],
    slots: 50,
  });

  console.log("Journey worker started, waiting for workflow runs...");
  await worker.start();
}

main().catch((err) => {
  console.error("Worker failed:", err);
  process.exit(1);
});
```

Add a script to `apps/api/package.json`:

```json
{
  "scripts": {
    "worker": "tsx watch src/worker.ts",
    "worker:prod": "node dist/worker.js"
  }
}
```

### 3.5 Event Ingestion + Enrollment

The `/v1/ingest` endpoint stores events and kicks off Hatchet workflows for matching journeys.

#### `apps/api/src/routes/ingest.ts`

```typescript
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { eq, and } from "drizzle-orm";
import { journeyStates, userEvents, emailPreferences } from "@growthhog/db/schema";
import type { JourneyDefinition, PropertyCondition } from "@growthhog/journey-engine/types";
import type { JourneyRegistry } from "@growthhog/journey-engine/registry";
import type { AppEnv } from "../app.js";
import { journeyRunner } from "../workflows/journey-runner.js";

const ingestRequestSchema = z.object({
  event: z.string().min(1),
  userId: z.string().min(1),
  userEmail: z.string().email().optional(),
  properties: z.record(z.unknown()).optional(),
  timestamp: z.string().datetime().optional(),
});

const ingestResponseSchema = z.object({
  stored: z.boolean(),
  enrollments: z.array(
    z.object({
      journeyId: z.string(),
      enrolled: z.boolean(),
      reason: z.string().optional(),
    }),
  ),
  exits: z.array(
    z.object({
      journeyId: z.string(),
      stateId: z.string(),
      exited: z.boolean(),
    }),
  ),
});

const ingestRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Ingestion"],
  summary: "Ingest an event",
  description:
    "Receives events from PostHog webhooks or direct API calls. Stores the event, checks for journey enrollment, and processes exit conditions.",
  request: {
    body: {
      content: {
        "application/json": { schema: ingestRequestSchema },
      },
    },
  },
  responses: {
    202: {
      content: {
        "application/json": { schema: ingestResponseSchema },
      },
      description: "Event accepted and processed",
    },
  },
});

export const ingestRouter = new OpenAPIHono<AppEnv>().openapi(
  ingestRoute,
  async (c) => {
    const body = c.req.valid("json");
    const { db, registry, logger } = c.get("container");
    const properties = body.properties ?? {};
    const userEmail = body.userEmail ?? "";

    // 1. Store the event
    await db.insert(userEvents).values({
      userId: body.userId,
      event: body.event,
      properties,
    });

    // 2. Check enrollment for matching journeys
    const enrollments = await checkEnrollment(db, registry, {
      userId: body.userId,
      userEmail,
      eventName: body.event,
      properties,
    });

    // 3. Check exit conditions on active journeys
    const exits = await checkExits(db, registry, {
      userId: body.userId,
      eventName: body.event,
      properties,
    });

    logger.info("Event ingested", {
      event: body.event,
      userId: body.userId,
      enrollments: enrollments.filter((e) => e.enrolled).length,
      exits: exits.filter((e) => e.exited).length,
    });

    return c.json({ stored: true, enrollments, exits }, 202);
  },
);

// --- Enrollment Logic ---

interface EnrollmentResult {
  journeyId: string;
  enrolled: boolean;
  reason?: string;
}

async function checkEnrollment(
  db: any,
  registry: JourneyRegistry,
  event: { userId: string; userEmail: string; eventName: string; properties: Record<string, unknown> },
): Promise<EnrollmentResult[]> {
  const matchingJourneys = registry.getByTriggerEvent(event.eventName);
  const results: EnrollmentResult[] = [];

  for (const journey of matchingJourneys) {
    if (!journey.enabled) {
      results.push({ journeyId: journey.id, enrolled: false, reason: "journey_disabled" });
      continue;
    }

    if (journey.trigger.where?.length) {
      if (!evaluateTriggerConditions(journey.trigger.where, event.properties)) {
        results.push({ journeyId: journey.id, enrolled: false, reason: "trigger_conditions_not_met" });
        continue;
      }
    }

    const entryAllowed = await checkEntryLimit(db, journey, event.userId);
    if (!entryAllowed.allowed) {
      results.push({ journeyId: journey.id, enrolled: false, reason: entryAllowed.reason });
      continue;
    }

    const prefs = await db.query.emailPreferences.findFirst({
      where: eq(emailPreferences.userId, event.userId),
    });
    if (prefs?.unsubscribedAll) {
      results.push({ journeyId: journey.id, enrolled: false, reason: "user_unsubscribed" });
      continue;
    }

    // Create the journey state record
    const [state] = await db
      .insert(journeyStates)
      .values({
        userId: event.userId,
        userEmail: event.userEmail,
        journeyId: journey.id,
        currentNodeId: journey.entryNode,
        status: "active",
        context: event.properties,
      })
      .returning();

    // Kick off the Hatchet workflow
    const ref = await journeyRunner.runNoWait({
      userId: event.userId,
      userEmail: event.userEmail,
      journeyId: journey.id,
      stateId: state.id,
      context: event.properties,
    });

    // Store the Hatchet run ID for observability
    await db
      .update(journeyStates)
      .set({ hatchetRunId: ref.workflowRunId })
      .where(eq(journeyStates.id, state.id));

    results.push({ journeyId: journey.id, enrolled: true });
  }

  return results;
}

function evaluateTriggerConditions(
  conditions: PropertyCondition[],
  properties: Record<string, unknown>,
): boolean {
  return conditions.every((condition) => {
    const value = properties[condition.property];
    switch (condition.operator) {
      case "eq": return value === condition.value;
      case "neq": return value !== condition.value;
      case "gt": return typeof value === "number" && typeof condition.value === "number" && value > condition.value;
      case "gte": return typeof value === "number" && typeof condition.value === "number" && value >= condition.value;
      case "lt": return typeof value === "number" && typeof condition.value === "number" && value < condition.value;
      case "lte": return typeof value === "number" && typeof condition.value === "number" && value <= condition.value;
      case "exists": return value !== undefined && value !== null;
      case "not_exists": return value === undefined || value === null;
      case "contains": return typeof value === "string" && typeof condition.value === "string" && value.includes(condition.value);
      default: return false;
    }
  });
}

async function checkEntryLimit(
  db: any,
  journey: JourneyDefinition,
  userId: string,
): Promise<{ allowed: boolean; reason?: string }> {
  if (journey.entryLimit === "unlimited") return { allowed: true };

  if (journey.entryLimit === "once") {
    const existing = await db.query.journeyStates.findFirst({
      where: and(
        eq(journeyStates.userId, userId),
        eq(journeyStates.journeyId, journey.id),
      ),
    });
    return existing
      ? { allowed: false, reason: "already_entered_once" }
      : { allowed: true };
  }

  if (journey.entryLimit === "once_per_period") {
    const periodMs = (journey.entryPeriodHours ?? 24) * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - periodMs);

    const existing = await db.query.journeyStates.findFirst({
      where: and(
        eq(journeyStates.userId, userId),
        eq(journeyStates.journeyId, journey.id),
      ),
      orderBy: (states: any, { desc }: any) => [desc(states.createdAt)],
    });

    return existing && existing.createdAt > cutoff
      ? { allowed: false, reason: "period_not_elapsed" }
      : { allowed: true };
  }

  return { allowed: true };
}

// --- Exit Logic ---

interface ExitResult {
  journeyId: string;
  stateId: string;
  exited: boolean;
}

async function checkExits(
  db: any,
  registry: JourneyRegistry,
  event: { userId: string; eventName: string; properties: Record<string, unknown> },
): Promise<ExitResult[]> {
  const results: ExitResult[] = [];

  const activeStates = await db.query.journeyStates.findMany({
    where: and(
      eq(journeyStates.userId, event.userId),
      eq(journeyStates.status, "active"),
    ),
  });

  for (const state of activeStates) {
    const journey = registry.get(state.journeyId);
    if (!journey?.exitOn) continue;

    const shouldExit = journey.exitOn.some((exitCondition) => {
      if (exitCondition.event !== event.eventName) return false;
      if (!exitCondition.where?.length) return true;
      return evaluateTriggerConditions(exitCondition.where, event.properties);
    });

    if (shouldExit) {
      await db
        .update(journeyStates)
        .set({ status: "exited", updatedAt: new Date() })
        .where(eq(journeyStates.id, state.id));

      // TODO: Cancel the Hatchet workflow run via state.hatchetRunId

      results.push({ journeyId: state.journeyId, stateId: state.id, exited: true });
    } else {
      results.push({ journeyId: state.journeyId, stateId: state.id, exited: false });
    }
  }

  return results;
}
```

#### Update `apps/api/src/routes/index.ts`

```typescript
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../app.js";
import { healthRouter } from "./health.js";
import { ingestRouter } from "./ingest.js";

export function registerRoutes(app: OpenAPIHono<AppEnv>) {
  const v1 = new OpenAPIHono<AppEnv>();

  v1.route("/health", healthRouter);
  v1.route("/ingest", ingestRouter);

  app.route("/v1", v1);
}
```

### 3.6 Verify Phase 3

```bash
# Start everything
docker compose up -d

# Run migrations (if schema was updated)
DATABASE_URL="postgresql://growthhog:growthhog@localhost:5434/growthhog" \
  pnpm --filter @growthhog/db db:push

# Terminal 1: Start the API
pnpm --filter @growthhog/api dev

# Terminal 2: Start the Hatchet worker
pnpm --filter @growthhog/api worker

# Terminal 3: Ingest an event
curl -X POST http://localhost:3002/v1/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "event": "user.created",
    "userId": "test-user-1",
    "userEmail": "test@example.com",
    "properties": { "plan": "free" }
  }'

# Expected:
# {
#   "stored": true,
#   "enrollments": [{ "journeyId": "activation-welcome", "enrolled": true }],
#   "exits": []
# }

# Check Hatchet dashboard at http://localhost:8888 — you should see
# a "journey-runner" workflow run for this user.

# Send again — should not enroll (entry limit "once")
curl -X POST http://localhost:3002/v1/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "event": "user.created",
    "userId": "test-user-1",
    "userEmail": "test@example.com"
  }'
# Expected: enrolled: false, reason: "already_entered_once"

# Test exit condition
curl -X POST http://localhost:3002/v1/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "event": "user.deleted",
    "userId": "test-user-1"
  }'
# Expected: exits: [{ journeyId: "activation-welcome", exited: true }]
```

Check the Hatchet dashboard to see the workflow execution — you'll see the journey runner sleeping at the wait_48h node, with full run history and step-level visibility.

---

## What the Activation Welcome Journey Looks Like in Hatchet

When a `user.created` event comes in, here's what happens:

```
1. POST /v1/ingest { event: "user.created", userId: "u1", userEmail: "u1@test.com" }
2. Event stored in user_events table
3. Registry matches "user.created" → activation-welcome journey
4. Entry limit check passes (first time)
5. journey_states row created (status: active, node: send_welcome)
6. journeyRunner.runNoWait() kicks off Hatchet workflow

In Hatchet (journey-runner durableTask):
  → Process "send_welcome" action node → inserts email_sends row (stub)
  → Process "wait_48h" wait node → ctx.sleepFor('48h') — worker slot freed
  ... 48 hours later, Hatchet resumes ...
  → Process "check_engagement" condition node → queries user_events for "feature.used"
  → If found: process "send_advanced" → wait 48h → "send_community" → complete
  → If not: process "send_nudge" → wait 48h → "send_community" → complete
```

Total time: ~4-5 days. Hatchet handles the entire lifecycle durably — crashes, restarts, deploys don't interrupt the journey.

---

## What Comes Next (Phase 4+)

| Phase | What | Notes |
|-------|------|-------|
| 4 | Schema updates | Add `templateKey` to email_sends, `suppressed`/`bounceCount` to email_preferences |
| 5 | Resend integration | React Email rendering, real email sending via Resend API |
| 6 | Link rewriting + click tracking | `/track/click/:id` endpoint, link rewriting in email HTML |
| 7 | Open tracking pixel | `/track/open/:id` endpoint, 1x1 GIF injection |
| 8 | Suppression logic | Frequency cap, daily cap, preferences check before sending |
| 9 | Unsubscribe endpoint | `/unsubscribe/:token` + Resend webhook handler for bounces/complaints |
| 10 | PostHog event push-back | Push journey events back to PostHog for analytics |
| 11 | Admin/debug API | Endpoints to inspect journey states, replay, cancel |
| 12 | Hatchet run cancellation | Cancel workflow runs on exit events, implement in checkExits |

The Resend integration (Phase 5) is the next critical piece — it replaces the email stub in `executeAction` with real email delivery.

---

## Common Commands

```bash
# Start all infrastructure (Postgres + Redis + Hatchet)
docker compose up -d

# Generate migration from schema changes
DATABASE_URL="postgresql://growthhog:growthhog@localhost:5434/growthhog" \
  pnpm --filter @growthhog/db db:generate

# Run migrations
DATABASE_URL="postgresql://growthhog:growthhog@localhost:5434/growthhog" \
  pnpm --filter @growthhog/db db:migrate

# Quick-push schema (dev only)
DATABASE_URL="postgresql://growthhog:growthhog@localhost:5434/growthhog" \
  pnpm --filter @growthhog/db db:push

# Type check everything
pnpm check-types

# Lint everything
pnpm lint

# Start API dev server
pnpm --filter @growthhog/api dev

# Start Hatchet worker (separate terminal)
pnpm --filter @growthhog/api worker

# Start all dev servers
pnpm dev

# Hatchet dashboard
open http://localhost:8888
```
