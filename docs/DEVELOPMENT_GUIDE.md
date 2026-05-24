# Journey Engine — Development Guide (Foundation Phases 1-4)

Complete implementation guide for the first 4 foundation layers. Each phase builds on the previous. Follow in order.

---

## Prerequisites

- Docker running (for TimescaleDB + Redis via docker-compose)
- Node.js >= 18
- pnpm 9+

Run the setup script to install deps, start containers, and create `.env`:

```bash
pnpm setup
```

Or manually:

```bash
docker compose up -d
pnpm install
```

This gives you:
- **Postgres** (TimescaleDB, PG18) at `localhost:5432` — user/pass/db: `growthhog`
- **Redis** at `localhost:6379`

---

## Architecture Overview

```
growthhog/
  apps/
    api/               ← Hono HTTP layer. Thin — routes, middleware, env
  packages/
    journey-engine/    ← Core engine. DB schema, types, registry, state machine, conditions, actions
```

The API depends on the engine (`@growthhog/journey-engine` workspace dep). The engine has zero Hono knowledge — it receives a DB connection and returns results. This keeps it testable and extractable to a standalone npm package later.

**Key technology choices:**
- **Drizzle ORM** — TypeScript-first schema, lightweight, raw SQL escape hatches, declarative migrations
- **postgres.js** (`postgres` package) — ESM-native Postgres driver, no native deps, perfect for Drizzle
- **pg-boss** — Postgres-backed job queue. No Redis needed for V1.
- **Zod 4** — Runtime validation of journey definitions at load time and API inputs
- **No drizzle-zod** — Project uses Zod 4, drizzle-zod targets Zod 3. Keep ORM schemas and validation schemas separate.

---

## Phase 1: Database Layer

### 1.1 Create the `packages/journey-engine` Package

Create the directory structure:

```
packages/journey-engine/
  package.json
  tsconfig.json
  drizzle.config.ts
  src/
    index.ts
    db/
      index.ts
      schema/
        index.ts
        journey-states.ts
        journey-logs.ts
        email-sends.ts
        tracked-links.ts
        link-clicks.ts
        email-preferences.ts
        user-events.ts
      migrate.ts
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
    "./db": "./src/db/index.ts",
    "./db/schema": "./src/db/schema/index.ts",
    "./types": "./src/types/index.ts",
    "./registry": "./src/registry/index.ts",
    "./ingestion": "./src/ingestion/index.ts",
    "./engine": "./src/engine/index.ts",
    "./conditions": "./src/conditions/index.ts",
    "./actions": "./src/actions/index.ts"
  },
  "scripts": {
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/db/migrate.ts",
    "db:push": "drizzle-kit push",
    "db:studio": "drizzle-kit studio",
    "check-types": "tsc --noEmit"
  },
  "dependencies": {
    "drizzle-orm": "latest",
    "postgres": "latest",
    "zod": "latest"
  },
  "devDependencies": {
    "@repo/typescript-config": "workspace:*",
    "drizzle-kit": "latest",
    "tsx": "latest",
    "@types/node": "latest"
  }
}
```

Note: Use `pnpm add` to install (this ensures lock file is correct). The above is a reference. Actual install:

```bash
# From repo root:
mkdir -p packages/journey-engine/src/db/schema
cd packages/journey-engine

# Initialize the package.json first with the structure above, then:
pnpm --filter @growthhog/journey-engine add drizzle-orm postgres zod
pnpm --filter @growthhog/journey-engine add -D drizzle-kit tsx @types/node @repo/typescript-config
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

#### `packages/journey-engine/drizzle.config.ts`

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

### 1.2 Database Connection Factory

#### `packages/journey-engine/src/db/index.ts`

```typescript
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export function createDb(databaseUrl: string) {
  const client = postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;
```

### 1.3 Schema Definitions

All 7 tables from the product spec, translated to Drizzle.

#### `packages/journey-engine/src/db/schema/index.ts`

```typescript
export * from "./journey-states.js";
export * from "./journey-logs.js";
export * from "./email-sends.js";
export * from "./tracked-links.js";
export * from "./link-clicks.js";
export * from "./email-preferences.js";
export * from "./user-events.js";
```

#### `packages/journey-engine/src/db/schema/journey-states.ts`

```typescript
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const journeyStates = pgTable(
  "journey_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    userEmail: text("user_email").notNull(),
    journeyId: text("journey_id").notNull(),
    currentNode: text("current_node").notNull(),
    status: text("status", {
      enum: ["active", "completed", "exited", "paused", "error"],
    })
      .notNull()
      .default("active"),
    enteredAt: timestamp("entered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    nodeEnteredAt: timestamp("node_entered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    nextEvalAt: timestamp("next_eval_at", { withTimezone: true }),
    context: jsonb("context").$type<Record<string, unknown>>().default({}),
    errorMessage: text("error_message"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_user_journey_active").on(
      table.userId,
      table.journeyId,
      table.status,
    ),
    index("idx_journey_pending").on(table.nextEvalAt).where(
      sql`${table.status} = 'active' AND ${table.nextEvalAt} IS NOT NULL`,
    ),
    index("idx_journey_user").on(table.userId, table.status),
  ],
);

export type JourneyState = typeof journeyStates.$inferSelect;
export type NewJourneyState = typeof journeyStates.$inferInsert;
```

#### `packages/journey-engine/src/db/schema/journey-logs.ts`

```typescript
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export const journeyLogs = pgTable(
  "journey_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    journeyId: text("journey_id").notNull(),
    fromNode: text("from_node"),
    toNode: text("to_node"),
    actionType: text("action_type"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_logs_user_journey").on(
      table.userId,
      table.journeyId,
      table.createdAt,
    ),
  ],
);

export type JourneyLog = typeof journeyLogs.$inferSelect;
export type NewJourneyLog = typeof journeyLogs.$inferInsert;
```

#### `packages/journey-engine/src/db/schema/email-sends.ts`

```typescript
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const emailSends = pgTable(
  "email_sends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    userEmail: text("user_email").notNull(),
    journeyId: text("journey_id"),
    journeyNode: text("journey_node"),
    templateKey: text("template_key").notNull(),
    subject: text("subject").notNull(),
    resendId: text("resend_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    clickedAt: timestamp("clicked_at", { withTimezone: true }),
    bouncedAt: timestamp("bounced_at", { withTimezone: true }),
    complainedAt: timestamp("complained_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_sends_user").on(table.userId, table.sentAt),
    index("idx_sends_resend").on(table.resendId),
  ],
);

export type EmailSend = typeof emailSends.$inferSelect;
export type NewEmailSend = typeof emailSends.$inferInsert;
```

#### `packages/journey-engine/src/db/schema/tracked-links.ts`

```typescript
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { emailSends } from "./email-sends.js";

export const trackedLinks = pgTable(
  "tracked_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sendId: uuid("send_id")
      .notNull()
      .references(() => emailSends.id, { onDelete: "cascade" }),
    originalUrl: text("original_url").notNull(),
    clickCount: integer("click_count").default(0),
    firstClicked: timestamp("first_clicked", { withTimezone: true }),
    lastClicked: timestamp("last_clicked", { withTimezone: true }),
  },
  (table) => [index("idx_links_send").on(table.sendId)],
);

export type TrackedLink = typeof trackedLinks.$inferSelect;
export type NewTrackedLink = typeof trackedLinks.$inferInsert;
```

#### `packages/journey-engine/src/db/schema/link-clicks.ts`

```typescript
import {
  pgTable,
  uuid,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { trackedLinks } from "./tracked-links.js";

export const linkClicks = pgTable("link_clicks", {
  id: uuid("id").primaryKey().defaultRandom(),
  linkId: uuid("link_id")
    .notNull()
    .references(() => trackedLinks.id, { onDelete: "cascade" }),
  clickedAt: timestamp("clicked_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  userAgent: text("user_agent"),
  ipHash: text("ip_hash"),
});

export type LinkClick = typeof linkClicks.$inferSelect;
export type NewLinkClick = typeof linkClicks.$inferInsert;
```

#### `packages/journey-engine/src/db/schema/email-preferences.ts`

```typescript
import {
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

export const emailPreferences = pgTable("email_preferences", {
  userId: text("user_id").primaryKey(),
  unsubscribed: boolean("unsubscribed").default(false),
  categories: jsonb("categories")
    .$type<Record<string, boolean>>()
    .default({}),
  bounceCount: integer("bounce_count").default(0),
  suppressed: boolean("suppressed").default(false),
  suppressedAt: timestamp("suppressed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export type EmailPreference = typeof emailPreferences.$inferSelect;
export type NewEmailPreference = typeof emailPreferences.$inferInsert;
```

#### `packages/journey-engine/src/db/schema/user-events.ts`

```typescript
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export const userEvents = pgTable(
  "user_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    eventName: text("event_name").notNull(),
    properties: jsonb("properties")
      .$type<Record<string, unknown>>()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_events_user_name").on(
      table.userId,
      table.eventName,
      table.createdAt,
    ),
  ],
);

export type UserEvent = typeof userEvents.$inferSelect;
export type NewUserEvent = typeof userEvents.$inferInsert;
```

### 1.4 Migration Runner

#### `packages/journey-engine/src/db/migrate.ts`

```typescript
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}

const client = postgres(databaseUrl, { max: 1 });
const db = drizzle(client);

console.log("Running migrations...");
await migrate(db, { migrationsFolder: new URL("./migrations", import.meta.url).pathname });
console.log("Migrations complete.");

await client.end();
process.exit(0);
```

### 1.5 Generate and Run First Migration

```bash
# Make sure Postgres is running
docker compose up -d

# Generate SQL migration from schema
DATABASE_URL="postgresql://growthhog:growthhog@localhost:5432/growthhog" \
  pnpm --filter @growthhog/journey-engine db:generate

# Run the migration
DATABASE_URL="postgresql://growthhog:growthhog@localhost:5432/growthhog" \
  pnpm --filter @growthhog/journey-engine db:migrate
```

Alternatively for rapid dev iteration (applies schema directly, no migration files):

```bash
DATABASE_URL="postgresql://growthhog:growthhog@localhost:5432/growthhog" \
  pnpm --filter @growthhog/journey-engine db:push
```

### 1.6 Wire DB into API Container

Add the engine as a workspace dependency to the API:

```bash
pnpm --filter @growthhog/api add @growthhog/journey-engine@workspace:*
```

Update `apps/api/src/container.ts`:

```typescript
import { env } from "./env.js";
import { createLogger, type Logger } from "./lib/logger.js";
import { createDb, type Db } from "@growthhog/journey-engine/db";

export interface Container {
  env: typeof env;
  logger: Logger;
  db: Db;
}

export function createContainer(): Container {
  const logger = createLogger(env.LOG_LEVEL);
  const db = createDb(env.DATABASE_URL);

  return {
    env,
    logger,
    db,
  };
}
```

### 1.7 Barrel Export

#### `packages/journey-engine/src/index.ts`

```typescript
export { createDb, type Db } from "./db/index.js";
export * from "./db/schema/index.js";
```

This will be expanded as we add types, registry, engine, etc.

### 1.8 Verify Phase 1

```bash
# Start Postgres
docker compose up -d

# Run migrations
DATABASE_URL="postgresql://growthhog:growthhog@localhost:5432/growthhog" \
  pnpm --filter @growthhog/journey-engine db:migrate

# Start the API (should connect to DB on boot)
pnpm --filter @growthhog/api dev

# Verify health
curl http://localhost:3001/v1/health
# Should return {"status":"healthy",...}
```

---

## Phase 2: Journey Type System + Registry

### 2.1 Directory Structure

```
packages/journey-engine/src/
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
```

### 2.2 Type Definitions

These map directly to the spec. They are runtime types (interfaces) used throughout the engine.

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
  source: "posthog" | "context";
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
  suppressHours?: number;
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

These validate journey definitions at load time. If a journey file has a typo or invalid structure, it fails loudly at startup rather than silently at runtime.

#### `packages/journey-engine/src/schemas/index.ts`

```typescript
export { journeyDefinitionSchema } from "./journey.schema.js";
```

#### `packages/journey-engine/src/schemas/journey.schema.ts`

```typescript
import { z } from "zod";

const propertyConditionSchema = z.object({
  type: z.literal("property"),
  source: z.enum(["posthog", "context"]),
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
  suppressHours: z.number().positive().optional(),
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

The registry is a runtime container for all loaded journey definitions. It provides fast lookups by trigger event and journey ID.

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

### 2.5 First Journey Definition

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

### 2.6 Wire Registry into Container

Update `apps/api/src/container.ts`:

```typescript
import { env } from "./env.js";
import { createLogger, type Logger } from "./lib/logger.js";
import { createDb, type Db } from "@growthhog/journey-engine/db";
import { type JourneyRegistry } from "@growthhog/journey-engine/registry";
import { createJourneyRegistry } from "./journeys/index.js";

export interface Container {
  env: typeof env;
  logger: Logger;
  db: Db;
  registry: JourneyRegistry;
}

export function createContainer(): Container {
  const logger = createLogger(env.LOG_LEVEL);
  const db = createDb(env.DATABASE_URL);
  const registry = createJourneyRegistry();

  logger.info(`Journey registry loaded: ${registry.count()} journeys`);

  return {
    env,
    logger,
    db,
    registry,
  };
}
```

### 2.7 Update Barrel Export

#### `packages/journey-engine/src/index.ts`

```typescript
export { createDb, type Db } from "./db/index.js";
export * from "./db/schema/index.js";
export * from "./types/index.js";
export { journeyDefinitionSchema } from "./schemas/index.js";
export { JourneyRegistry } from "./registry/index.js";
```

### 2.8 Verify Phase 2

```bash
# Type check the engine package
pnpm --filter @growthhog/journey-engine check-types

# Type check the API (should resolve workspace imports)
pnpm --filter @growthhog/api check-types

# Start the API — should log "Journey registry loaded: 1 journeys"
pnpm --filter @growthhog/api dev
```

---

## Phase 3: Event Ingestion + Enrollment

### 3.1 Directory Structure

```
packages/journey-engine/src/
  ingestion/
    index.ts
    ingest-event.ts
    store-event.ts
    check-enrollment.ts
    check-exits.ts

apps/api/src/
  routes/
    ingest.ts          (new)
    index.ts           (update to mount ingest)
```

### 3.2 Ingestion Logic (Engine Package)

#### `packages/journey-engine/src/ingestion/index.ts`

```typescript
export { ingestEvent, type IngestEventInput, type IngestEventResult } from "./ingest-event.js";
export { storeEvent } from "./store-event.js";
export { checkEnrollment, type EnrollmentResult } from "./check-enrollment.js";
export { checkExits } from "./check-exits.js";
```

#### `packages/journey-engine/src/ingestion/store-event.ts`

```typescript
import type { Db } from "../db/index.js";
import { userEvents } from "../db/schema/index.js";

export interface EventInput {
  userId: string;
  eventName: string;
  properties?: Record<string, unknown>;
}

export async function storeEvent(db: Db, event: EventInput): Promise<void> {
  await db.insert(userEvents).values({
    userId: event.userId,
    eventName: event.eventName,
    properties: event.properties ?? {},
  });
}
```

#### `packages/journey-engine/src/ingestion/check-enrollment.ts`

```typescript
import { eq, and } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { journeyStates } from "../db/schema/index.js";
import { emailPreferences } from "../db/schema/index.js";
import type { JourneyDefinition } from "../types/index.js";
import type { JourneyRegistry } from "../registry/index.js";
import type { PropertyCondition } from "../types/conditions.js";

export interface EnrollmentResult {
  journeyId: string;
  enrolled: boolean;
  reason?: string;
}

export async function checkEnrollment(
  db: Db,
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

    // Check trigger.where conditions
    if (journey.trigger.where && journey.trigger.where.length > 0) {
      const conditionsMet = evaluateTriggerConditions(journey.trigger.where, event.properties);
      if (!conditionsMet) {
        results.push({ journeyId: journey.id, enrolled: false, reason: "trigger_conditions_not_met" });
        continue;
      }
    }

    // Check entry limit
    const entryAllowed = await checkEntryLimit(db, journey, event.userId);
    if (!entryAllowed.allowed) {
      results.push({ journeyId: journey.id, enrolled: false, reason: entryAllowed.reason });
      continue;
    }

    // Check suppression
    const prefs = await db.query.emailPreferences.findFirst({
      where: eq(emailPreferences.userId, event.userId),
    });
    if (prefs?.suppressed) {
      results.push({ journeyId: journey.id, enrolled: false, reason: "user_suppressed" });
      continue;
    }
    if (prefs?.unsubscribed) {
      results.push({ journeyId: journey.id, enrolled: false, reason: "user_unsubscribed" });
      continue;
    }

    // Enroll
    await db.insert(journeyStates).values({
      userId: event.userId,
      userEmail: event.userEmail,
      journeyId: journey.id,
      currentNode: journey.entryNode,
      status: "active",
      nextEvalAt: new Date(),
      context: event.properties,
    });

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
  db: Db,
  journey: JourneyDefinition,
  userId: string,
): Promise<{ allowed: boolean; reason?: string }> {
  if (journey.entryLimit === "unlimited") {
    return { allowed: true };
  }

  if (journey.entryLimit === "once") {
    const existing = await db.query.journeyStates.findFirst({
      where: and(
        eq(journeyStates.userId, userId),
        eq(journeyStates.journeyId, journey.id),
      ),
    });
    if (existing) {
      return { allowed: false, reason: "already_entered_once" };
    }
    return { allowed: true };
  }

  if (journey.entryLimit === "once_per_period") {
    const periodMs = (journey.entryPeriodHours ?? 24) * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - periodMs);

    const existing = await db.query.journeyStates.findFirst({
      where: and(
        eq(journeyStates.userId, userId),
        eq(journeyStates.journeyId, journey.id),
      ),
      orderBy: (states, { desc }) => [desc(states.enteredAt)],
    });

    if (existing && existing.enteredAt > cutoff) {
      return { allowed: false, reason: "period_not_elapsed" };
    }
    return { allowed: true };
  }

  return { allowed: true };
}
```

#### `packages/journey-engine/src/ingestion/check-exits.ts`

```typescript
import { eq, and } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { journeyStates, journeyLogs } from "../db/schema/index.js";
import type { JourneyRegistry } from "../registry/index.js";
import type { PropertyCondition } from "../types/conditions.js";

export interface ExitResult {
  journeyId: string;
  stateId: string;
  exited: boolean;
}

export async function checkExits(
  db: Db,
  registry: JourneyRegistry,
  event: { userId: string; eventName: string; properties: Record<string, unknown> },
): Promise<ExitResult[]> {
  const results: ExitResult[] = [];

  // Find all active journey states for this user
  const activeStates = await db.query.journeyStates.findMany({
    where: and(
      eq(journeyStates.userId, event.userId),
      eq(journeyStates.status, "active"),
    ),
  });

  for (const state of activeStates) {
    const journey = registry.get(state.journeyId);
    if (!journey || !journey.exitOn) continue;

    const shouldExit = journey.exitOn.some((exitCondition) => {
      if (exitCondition.event !== event.eventName) return false;
      if (!exitCondition.where || exitCondition.where.length === 0) return true;
      return evaluateExitConditions(exitCondition.where, event.properties);
    });

    if (shouldExit) {
      await db
        .update(journeyStates)
        .set({ status: "exited", updatedAt: new Date() })
        .where(eq(journeyStates.id, state.id));

      await db.insert(journeyLogs).values({
        userId: state.userId,
        journeyId: state.journeyId,
        fromNode: state.currentNode,
        toNode: null,
        actionType: "exit",
        result: { reason: "exit_event", event: event.eventName },
      });

      results.push({ journeyId: state.journeyId, stateId: state.id, exited: true });
    } else {
      results.push({ journeyId: state.journeyId, stateId: state.id, exited: false });
    }
  }

  return results;
}

function evaluateExitConditions(
  conditions: PropertyCondition[],
  properties: Record<string, unknown>,
): boolean {
  return conditions.every((condition) => {
    const value = properties[condition.property];
    switch (condition.operator) {
      case "eq": return value === condition.value;
      case "neq": return value !== condition.value;
      case "exists": return value !== undefined && value !== null;
      case "not_exists": return value === undefined || value === null;
      default: return false;
    }
  });
}
```

#### `packages/journey-engine/src/ingestion/ingest-event.ts`

The orchestrator that calls store, enrollment, and exit checks.

```typescript
import type { Db } from "../db/index.js";
import type { JourneyRegistry } from "../registry/index.js";
import { storeEvent } from "./store-event.js";
import { checkEnrollment, type EnrollmentResult } from "./check-enrollment.js";
import { checkExits, type ExitResult } from "./check-exits.js";

export interface IngestEventInput {
  event: string;
  userId: string;
  userEmail?: string;
  properties?: Record<string, unknown>;
  timestamp?: string;
}

export interface IngestEventResult {
  stored: boolean;
  enrollments: EnrollmentResult[];
  exits: ExitResult[];
}

export async function ingestEvent(
  db: Db,
  registry: JourneyRegistry,
  input: IngestEventInput,
): Promise<IngestEventResult> {
  const properties = input.properties ?? {};
  const userEmail = input.userEmail ?? "";

  // 1. Store locally
  await storeEvent(db, {
    userId: input.userId,
    eventName: input.event,
    properties,
  });

  // 2. Check enrollment
  const enrollments = await checkEnrollment(db, registry, {
    userId: input.userId,
    userEmail,
    eventName: input.event,
    properties,
  });

  // 3. Check active journeys for exit conditions
  const exits = await checkExits(db, registry, {
    userId: input.userId,
    eventName: input.event,
    properties,
  });

  return {
    stored: true,
    enrollments,
    exits,
  };
}
```

### 3.3 Ingestion Route (API)

#### `apps/api/src/routes/ingest.ts`

```typescript
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../app.js";
import { ingestEvent } from "@growthhog/journey-engine/ingestion";

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

    const result = await ingestEvent(db, registry, body);

    logger.info("Event ingested", {
      event: body.event,
      userId: body.userId,
      enrollments: result.enrollments.filter((e) => e.enrolled).length,
      exits: result.exits.filter((e) => e.exited).length,
    });

    return c.json(result, 202);
  },
);
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

### 3.4 Verify Phase 3

```bash
# Start everything
docker compose up -d
pnpm --filter @growthhog/api dev

# Ingest an event that triggers the activation-welcome journey
curl -X POST http://localhost:3001/v1/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "event": "user.created",
    "userId": "test-user-1",
    "userEmail": "test@example.com",
    "properties": { "plan": "free" }
  }'

# Expected response:
# {
#   "stored": true,
#   "enrollments": [{ "journeyId": "activation-welcome", "enrolled": true }],
#   "exits": []
# }

# Send again — should not enroll (entry limit "once")
curl -X POST http://localhost:3001/v1/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "event": "user.created",
    "userId": "test-user-1",
    "userEmail": "test@example.com"
  }'

# Expected: enrolled: false, reason: "already_entered_once"

# Test exit condition
curl -X POST http://localhost:3001/v1/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "event": "user.deleted",
    "userId": "test-user-1"
  }'

# Expected: exits: [{ journeyId: "activation-welcome", exited: true }]
```

---

## Phase 4: State Machine Core

### 4.1 Directory Structure

```
packages/journey-engine/src/
  engine/
    index.ts
    evaluate-node.ts
    evaluate-wait.ts
    evaluate-condition.ts
    evaluate-action.ts
    advance.ts
    types.ts
  conditions/
    index.ts
    evaluate.ts
    property.ts
    event.ts
    email-engagement.ts
    composite.ts
  actions/
    index.ts
    router.ts
    send-email.ts
    fire-event.ts
    webhook.ts
    enroll-journey.ts
```

### 4.2 Engine Types

#### `packages/journey-engine/src/engine/types.ts`

```typescript
export type EvaluationAction =
  | { action: "advance"; nextNode: string | null }
  | { action: "wait"; evalAt: Date }
  | { action: "error"; message: string };

export interface EvaluationResult {
  advances: number;
  finalNode: string | null;
  completed: boolean;
  errored: boolean;
  errorMessage?: string;
}
```

### 4.3 Wait Node Evaluator

#### `packages/journey-engine/src/engine/evaluate-wait.ts`

```typescript
import type { WaitNode } from "../types/index.js";
import type { JourneyState } from "../db/schema/index.js";
import type { EvaluationAction } from "./types.js";

export function evaluateWaitNode(
  node: WaitNode,
  state: JourneyState,
): EvaluationAction {
  const nodeEnteredAt = state.nodeEnteredAt.getTime();
  const requiredMs = node.hours * 60 * 60 * 1000;
  const elapsed = Date.now() - nodeEnteredAt;

  if (elapsed >= requiredMs) {
    return { action: "advance", nextNode: node.next };
  }

  return {
    action: "wait",
    evalAt: new Date(nodeEnteredAt + requiredMs),
  };
}
```

### 4.4 Condition Evaluators

#### `packages/journey-engine/src/conditions/index.ts`

```typescript
export { evaluateCondition } from "./evaluate.js";
```

#### `packages/journey-engine/src/conditions/evaluate.ts`

```typescript
import type { Db } from "../db/index.js";
import type { ConditionEval } from "../types/index.js";
import type { JourneyState } from "../db/schema/index.js";
import { evaluatePropertyCondition } from "./property.js";
import { evaluateEventCondition } from "./event.js";
import { evaluateEmailEngagementCondition } from "./email-engagement.js";
import { evaluateCompositeCondition } from "./composite.js";

export interface ConditionContext {
  db: Db;
  state: JourneyState;
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

export async function evaluatePropertyCondition(
  condition: PropertyCondition,
  ctx: ConditionContext,
): Promise<boolean> {
  let value: unknown;

  if (condition.source === "context") {
    const context = (ctx.state.context ?? {}) as Record<string, unknown>;
    value = context[condition.property];
  } else if (condition.source === "posthog") {
    // PostHog person properties lookup — stub for now.
    // In production, this calls the PostHog API:
    // GET /api/persons/?distinct_id={userId}
    // and caches the response for 5 minutes.
    // For V1, we skip this and return false (condition not evaluable without PostHog).
    return false;
  }

  return compareValue(value, condition.operator, condition.value);
}

function compareValue(
  actual: unknown,
  operator: PropertyCondition["operator"],
  expected: PropertyCondition["value"],
): boolean {
  switch (operator) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "gt":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "gte":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "lt":
      return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "lte":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "exists":
      return actual !== undefined && actual !== null;
    case "not_exists":
      return actual === undefined || actual === null;
    case "contains":
      return typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
    default:
      return false;
  }
}
```

#### `packages/journey-engine/src/conditions/event.ts`

```typescript
import { eq, and, gte, sql } from "drizzle-orm";
import type { EventCondition } from "../types/index.js";
import type { ConditionContext } from "./evaluate.js";
import { userEvents } from "../db/schema/index.js";

export async function evaluateEventCondition(
  condition: EventCondition,
  ctx: ConditionContext,
): Promise<boolean> {
  const { db, state } = ctx;

  let query = db
    .select({ count: sql<number>`count(*)` })
    .from(userEvents)
    .where(
      and(
        eq(userEvents.userId, state.userId),
        eq(userEvents.eventName, condition.eventName),
        condition.withinHours
          ? gte(
              userEvents.createdAt,
              new Date(Date.now() - condition.withinHours * 60 * 60 * 1000),
            )
          : undefined,
      ),
    );

  const [result] = await query;
  const count = Number(result?.count ?? 0);

  switch (condition.check) {
    case "exists":
      return count > 0;
    case "not_exists":
      return count === 0;
    case "count": {
      if (!condition.operator || condition.value === undefined) return count > 0;
      return compareCount(count, condition.operator, condition.value);
    }
    default:
      return false;
  }
}

function compareCount(
  count: number,
  operator: NonNullable<EventCondition["operator"]>,
  value: number,
): boolean {
  switch (operator) {
    case "gt": return count > value;
    case "gte": return count >= value;
    case "lt": return count < value;
    case "lte": return count <= value;
    case "eq": return count === value;
    default: return false;
  }
}
```

#### `packages/journey-engine/src/conditions/email-engagement.ts`

```typescript
import { eq, and, isNotNull, isNull } from "drizzle-orm";
import type { EmailEngagementCondition } from "../types/index.js";
import type { ConditionContext } from "./evaluate.js";
import { emailSends } from "../db/schema/index.js";

export async function evaluateEmailEngagementCondition(
  condition: EmailEngagementCondition,
  ctx: ConditionContext,
): Promise<boolean> {
  const { db, state } = ctx;

  const send = await db.query.emailSends.findFirst({
    where: and(
      eq(emailSends.userId, state.userId),
      eq(emailSends.templateKey, condition.templateKey),
    ),
    orderBy: (sends, { desc }) => [desc(sends.sentAt)],
  });

  if (!send) return false;

  switch (condition.check) {
    case "opened":
      return send.openedAt !== null;
    case "not_opened":
      return send.openedAt === null;
    case "clicked":
      return send.clickedAt !== null;
    case "not_clicked":
      return send.clickedAt === null;
    default:
      return false;
  }
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
      const result = await evaluateCondition(sub, ctx);
      if (!result) return false;
    }
    return true;
  }

  if (condition.operator === "or") {
    for (const sub of condition.conditions) {
      const result = await evaluateCondition(sub, ctx);
      if (result) return true;
    }
    return false;
  }

  return false;
}
```

### 4.5 Condition Node Evaluator

#### `packages/journey-engine/src/engine/evaluate-condition.ts`

```typescript
import type { ConditionNode } from "../types/index.js";
import type { JourneyState } from "../db/schema/index.js";
import type { Db } from "../db/index.js";
import type { EvaluationAction } from "./types.js";
import { evaluateCondition } from "../conditions/index.js";

export async function evaluateConditionNode(
  db: Db,
  node: ConditionNode,
  state: JourneyState,
): Promise<EvaluationAction> {
  const result = await evaluateCondition(node.eval, { db, state });

  return {
    action: "advance",
    nextNode: result ? node.onTrue : node.onFalse,
  };
}
```

### 4.6 Action Handlers

#### `packages/journey-engine/src/actions/index.ts`

```typescript
export { executeAction, type ActionContext, type ActionResult } from "./router.js";
```

#### `packages/journey-engine/src/actions/router.ts`

```typescript
import type { Db } from "../db/index.js";
import type { JourneyAction } from "../types/index.js";
import type { JourneyState } from "../db/schema/index.js";
import type { JourneyRegistry } from "../registry/index.js";
import { executeSendEmail } from "./send-email.js";
import { executeFireEvent } from "./fire-event.js";
import { executeWebhook } from "./webhook.js";
import { executeEnrollJourney } from "./enroll-journey.js";

export interface ActionContext {
  db: Db;
  state: JourneyState;
  registry: JourneyRegistry;
  suppressHours: number;
}

export interface ActionResult {
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

export async function executeAction(
  action: JourneyAction,
  ctx: ActionContext,
): Promise<ActionResult> {
  switch (action.type) {
    case "send_email":
      return executeSendEmail(action, ctx);
    case "fire_event":
      return executeFireEvent(action, ctx);
    case "webhook":
      return executeWebhook(action, ctx);
    case "enroll_journey":
      return executeEnrollJourney(action, ctx);
    default:
      return { success: false, error: `Unknown action type` };
  }
}
```

#### `packages/journey-engine/src/actions/send-email.ts`

Stub for V1. Real Resend integration comes in Phase 6.

```typescript
import type { SendEmailAction } from "../types/index.js";
import type { ActionContext, ActionResult } from "./router.js";
import { emailSends } from "../db/schema/index.js";

export async function executeSendEmail(
  action: SendEmailAction,
  ctx: ActionContext,
): Promise<ActionResult> {
  // TODO: Phase 6 — Real implementation:
  // 1. Check suppression (canSendEmail)
  // 2. Render React Email template
  // 3. Rewrite links
  // 4. Inject open tracking pixel
  // 5. Send via Resend API

  // For now: record the intent in email_sends and succeed
  const [send] = await ctx.db
    .insert(emailSends)
    .values({
      userId: ctx.state.userId,
      userEmail: ctx.state.userEmail,
      journeyId: ctx.state.journeyId,
      journeyNode: ctx.state.currentNode,
      templateKey: action.templateKey,
      subject: action.subject,
    })
    .returning();

  return {
    success: true,
    data: { emailSendId: send.id, stub: true },
  };
}
```

#### `packages/journey-engine/src/actions/fire-event.ts`

```typescript
import type { FireEventAction } from "../types/index.js";
import type { ActionContext, ActionResult } from "./router.js";
import { userEvents } from "../db/schema/index.js";

export async function executeFireEvent(
  action: FireEventAction,
  ctx: ActionContext,
): Promise<ActionResult> {
  // Store locally
  await ctx.db.insert(userEvents).values({
    userId: ctx.state.userId,
    eventName: action.eventName,
    properties: action.properties ?? {},
  });

  // TODO: Phase 11 — Push to PostHog
  // await pushToPostHog(action.eventName, ctx.state.userId, action.properties);

  return {
    success: true,
    data: { eventName: action.eventName },
  };
}
```

#### `packages/journey-engine/src/actions/webhook.ts`

```typescript
import type { WebhookAction } from "../types/index.js";
import type { ActionContext, ActionResult } from "./router.js";

export async function executeWebhook(
  action: WebhookAction,
  ctx: ActionContext,
): Promise<ActionResult> {
  const method = action.method ?? "POST";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(action.headers ?? {}),
  };

  // Template the body with state context
  const body = action.body
    ? JSON.stringify(templateBody(action.body, ctx))
    : undefined;

  const response = await fetch(action.url, { method, headers, body });

  if (!response.ok) {
    return {
      success: false,
      error: `Webhook returned ${response.status}: ${await response.text()}`,
    };
  }

  return {
    success: true,
    data: { status: response.status },
  };
}

function templateBody(
  body: Record<string, unknown>,
  ctx: ActionContext,
): Record<string, unknown> {
  const serialized = JSON.stringify(body);
  const templated = serialized
    .replace(/\{\{userId\}\}/g, ctx.state.userId)
    .replace(/\{\{userEmail\}\}/g, ctx.state.userEmail)
    .replace(/\{\{journeyId\}\}/g, ctx.state.journeyId);
  return JSON.parse(templated);
}
```

#### `packages/journey-engine/src/actions/enroll-journey.ts`

```typescript
import { eq, and } from "drizzle-orm";
import type { EnrollJourneyAction } from "../types/index.js";
import type { ActionContext, ActionResult } from "./router.js";
import { journeyStates } from "../db/schema/index.js";

export async function executeEnrollJourney(
  action: EnrollJourneyAction,
  ctx: ActionContext,
): Promise<ActionResult> {
  const targetJourney = ctx.registry.get(action.journeyId);
  if (!targetJourney) {
    return { success: false, error: `Journey '${action.journeyId}' not found in registry` };
  }

  if (!targetJourney.enabled) {
    return { success: false, error: `Journey '${action.journeyId}' is disabled` };
  }

  // Check if already enrolled
  if (targetJourney.entryLimit === "once") {
    const existing = await ctx.db.query.journeyStates.findFirst({
      where: and(
        eq(journeyStates.userId, ctx.state.userId),
        eq(journeyStates.journeyId, action.journeyId),
      ),
    });
    if (existing) {
      return { success: true, data: { skipped: true, reason: "already_enrolled" } };
    }
  }

  // Enroll
  await ctx.db.insert(journeyStates).values({
    userId: ctx.state.userId,
    userEmail: ctx.state.userEmail,
    journeyId: action.journeyId,
    currentNode: targetJourney.entryNode,
    status: "active",
    nextEvalAt: new Date(),
    context: ctx.state.context ?? {},
  });

  return {
    success: true,
    data: { enrolledJourneyId: action.journeyId },
  };
}
```

### 4.7 Action Node Evaluator

#### `packages/journey-engine/src/engine/evaluate-action.ts`

```typescript
import type { ActionNode } from "../types/index.js";
import type { JourneyState, JourneyDefinition } from "../db/schema/index.js";
import type { Db } from "../db/index.js";
import type { JourneyRegistry } from "../registry/index.js";
import type { EvaluationAction } from "./types.js";
import { executeAction } from "../actions/index.js";
import type { JourneyDefinition as JourneyDef } from "../types/index.js";

export async function evaluateActionNode(
  db: Db,
  registry: JourneyRegistry,
  node: ActionNode,
  state: JourneyState,
  journey: JourneyDef,
): Promise<EvaluationAction> {
  const result = await executeAction(node.action, {
    db,
    state,
    registry,
    suppressHours: journey.suppressHours,
  });

  if (!result.success) {
    return { action: "error", message: result.error ?? "Action failed" };
  }

  return { action: "advance", nextNode: node.next };
}
```

### 4.8 Advance Logic

#### `packages/journey-engine/src/engine/advance.ts`

```typescript
import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { journeyStates, journeyLogs } from "../db/schema/index.js";
import type { JourneyState } from "../db/schema/index.js";

export async function advanceToNode(
  db: Db,
  state: JourneyState,
  fromNode: string,
  toNode: string,
  actionType: string,
  result?: Record<string, unknown>,
): Promise<JourneyState> {
  const now = new Date();

  // Update state
  const [updated] = await db
    .update(journeyStates)
    .set({
      currentNode: toNode,
      nodeEnteredAt: now,
      nextEvalAt: now,
      updatedAt: now,
    })
    .where(eq(journeyStates.id, state.id))
    .returning();

  // Log transition
  await db.insert(journeyLogs).values({
    userId: state.userId,
    journeyId: state.journeyId,
    fromNode,
    toNode,
    actionType,
    result: result ?? {},
  });

  return updated;
}

export async function markComplete(
  db: Db,
  state: JourneyState,
): Promise<void> {
  const now = new Date();

  await db
    .update(journeyStates)
    .set({
      status: "completed",
      nextEvalAt: null,
      updatedAt: now,
    })
    .where(eq(journeyStates.id, state.id));

  await db.insert(journeyLogs).values({
    userId: state.userId,
    journeyId: state.journeyId,
    fromNode: state.currentNode,
    toNode: null,
    actionType: "journey_completed",
    result: {},
  });
}

export async function markError(
  db: Db,
  state: JourneyState,
  errorMessage: string,
): Promise<void> {
  const now = new Date();

  await db
    .update(journeyStates)
    .set({
      status: "error",
      errorMessage,
      nextEvalAt: null,
      updatedAt: now,
    })
    .where(eq(journeyStates.id, state.id));

  await db.insert(journeyLogs).values({
    userId: state.userId,
    journeyId: state.journeyId,
    fromNode: state.currentNode,
    toNode: null,
    actionType: "error",
    result: { error: errorMessage },
  });
}

export async function updateNextEval(
  db: Db,
  stateId: string,
  evalAt: Date,
): Promise<void> {
  await db
    .update(journeyStates)
    .set({ nextEvalAt: evalAt, updatedAt: new Date() })
    .where(eq(journeyStates.id, stateId));
}
```

### 4.9 Main Evaluation Loop

The heart of the engine. Evaluates one journey state through its nodes, chaining through instant nodes (conditions, actions) and stopping at wait nodes or completion.

#### `packages/journey-engine/src/engine/evaluate-node.ts`

```typescript
import type { Db } from "../db/index.js";
import type { JourneyRegistry } from "../registry/index.js";
import type { JourneyState } from "../db/schema/index.js";
import type { EvaluationResult } from "./types.js";
import { evaluateWaitNode } from "./evaluate-wait.js";
import { evaluateConditionNode } from "./evaluate-condition.js";
import { evaluateActionNode } from "./evaluate-action.js";
import { advanceToNode, markComplete, markError, updateNextEval } from "./advance.js";

const DEFAULT_MAX_ADVANCES = 10;

export async function evaluateJourneyState(
  db: Db,
  registry: JourneyRegistry,
  state: JourneyState,
  options?: { maxAdvances?: number },
): Promise<EvaluationResult> {
  const maxAdvances = options?.maxAdvances ?? DEFAULT_MAX_ADVANCES;
  let advances = 0;
  let currentState = state;

  while (advances < maxAdvances) {
    const journey = registry.get(currentState.journeyId);
    if (!journey) {
      await markError(db, currentState, `Journey '${currentState.journeyId}' not found in registry`);
      return { advances, finalNode: currentState.currentNode, completed: false, errored: true, errorMessage: "Journey not found" };
    }

    const node = journey.nodes[currentState.currentNode];
    if (!node) {
      await markError(db, currentState, `Node '${currentState.currentNode}' not found in journey '${currentState.journeyId}'`);
      return { advances, finalNode: currentState.currentNode, completed: false, errored: true, errorMessage: "Node not found" };
    }

    let evaluationAction;

    switch (node.type) {
      case "wait":
        evaluationAction = evaluateWaitNode(node, currentState);
        break;
      case "condition":
        evaluationAction = await evaluateConditionNode(db, node, currentState);
        break;
      case "action":
        evaluationAction = await evaluateActionNode(db, registry, node, currentState, journey);
        break;
      default:
        await markError(db, currentState, `Unknown node type`);
        return { advances, finalNode: currentState.currentNode, completed: false, errored: true, errorMessage: "Unknown node type" };
    }

    switch (evaluationAction.action) {
      case "wait":
        await updateNextEval(db, currentState.id, evaluationAction.evalAt);
        return { advances, finalNode: currentState.currentNode, completed: false, errored: false };

      case "advance": {
        if (evaluationAction.nextNode === null) {
          await markComplete(db, currentState);
          return { advances: advances + 1, finalNode: null, completed: true, errored: false };
        }

        currentState = await advanceToNode(
          db,
          currentState,
          currentState.currentNode,
          evaluationAction.nextNode,
          node.type,
        );
        advances++;
        continue;
      }

      case "error":
        await markError(db, currentState, evaluationAction.message);
        return { advances, finalNode: currentState.currentNode, completed: false, errored: true, errorMessage: evaluationAction.message };
    }
  }

  // Hit max advances — possible infinite loop guard
  return { advances, finalNode: currentState.currentNode, completed: false, errored: false };
}
```

### 4.10 Engine Barrel Export

#### `packages/journey-engine/src/engine/index.ts`

```typescript
export { evaluateJourneyState } from "./evaluate-node.js";
export type { EvaluationResult, EvaluationAction } from "./types.js";
```

### 4.11 Wire Engine Evaluation into Ingestion

After enrollment, immediately evaluate the new state so instant nodes (like "send email" at entry) fire without waiting for a scheduler tick.

Update `packages/journey-engine/src/ingestion/ingest-event.ts`:

```typescript
import type { Db } from "../db/index.js";
import type { JourneyRegistry } from "../registry/index.js";
import { storeEvent } from "./store-event.js";
import { checkEnrollment, type EnrollmentResult } from "./check-enrollment.js";
import { checkExits, type ExitResult } from "./check-exits.js";
import { evaluateJourneyState } from "../engine/index.js";
import { eq, and } from "drizzle-orm";
import { journeyStates } from "../db/schema/index.js";

export interface IngestEventInput {
  event: string;
  userId: string;
  userEmail?: string;
  properties?: Record<string, unknown>;
  timestamp?: string;
}

export interface IngestEventResult {
  stored: boolean;
  enrollments: EnrollmentResult[];
  exits: ExitResult[];
  evaluations: Array<{ journeyId: string; advances: number; completed: boolean }>;
}

export async function ingestEvent(
  db: Db,
  registry: JourneyRegistry,
  input: IngestEventInput,
): Promise<IngestEventResult> {
  const properties = input.properties ?? {};
  const userEmail = input.userEmail ?? "";

  // 1. Store locally
  await storeEvent(db, {
    userId: input.userId,
    eventName: input.event,
    properties,
  });

  // 2. Check enrollment
  const enrollments = await checkEnrollment(db, registry, {
    userId: input.userId,
    userEmail,
    eventName: input.event,
    properties,
  });

  // 3. Check active journeys for exit conditions
  const exits = await checkExits(db, registry, {
    userId: input.userId,
    eventName: input.event,
    properties,
  });

  // 4. Evaluate newly enrolled states immediately
  const evaluations: Array<{ journeyId: string; advances: number; completed: boolean }> = [];

  for (const enrollment of enrollments) {
    if (!enrollment.enrolled) continue;

    const state = await db.query.journeyStates.findFirst({
      where: and(
        eq(journeyStates.userId, input.userId),
        eq(journeyStates.journeyId, enrollment.journeyId),
        eq(journeyStates.status, "active"),
      ),
    });

    if (state) {
      const result = await evaluateJourneyState(db, registry, state);
      evaluations.push({
        journeyId: enrollment.journeyId,
        advances: result.advances,
        completed: result.completed,
      });
    }
  }

  // 5. Re-evaluate active states that this event might unblock
  // (e.g., user is on a condition node waiting for this event)
  const activeStates = await db.query.journeyStates.findMany({
    where: and(
      eq(journeyStates.userId, input.userId),
      eq(journeyStates.status, "active"),
    ),
  });

  for (const state of activeStates) {
    const journey = registry.get(state.journeyId);
    if (!journey) continue;

    const node = journey.nodes[state.currentNode];
    if (!node || node.type !== "condition") continue;

    // If the condition references an event, this incoming event might satisfy it
    if (node.eval.type === "event" && node.eval.eventName === input.event) {
      const result = await evaluateJourneyState(db, registry, state);
      evaluations.push({
        journeyId: state.journeyId,
        advances: result.advances,
        completed: result.completed,
      });
    }
  }

  return {
    stored: true,
    enrollments,
    exits,
    evaluations,
  };
}
```

### 4.12 Update Barrel Export

Final `packages/journey-engine/src/index.ts`:

```typescript
// Database
export { createDb, type Db } from "./db/index.js";
export * from "./db/schema/index.js";

// Types
export * from "./types/index.js";

// Validation
export { journeyDefinitionSchema } from "./schemas/index.js";

// Registry
export { JourneyRegistry } from "./registry/index.js";

// Ingestion
export { ingestEvent, type IngestEventInput, type IngestEventResult } from "./ingestion/index.js";

// Engine
export { evaluateJourneyState } from "./engine/index.js";
export type { EvaluationResult } from "./engine/index.js";

// Conditions
export { evaluateCondition } from "./conditions/index.js";

// Actions
export { executeAction } from "./actions/index.js";
```

### 4.13 Update Ingest Route Response Schema

Update `apps/api/src/routes/ingest.ts` to include evaluations in response:

```typescript
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
  evaluations: z.array(
    z.object({
      journeyId: z.string(),
      advances: z.number(),
      completed: z.boolean(),
    }),
  ),
});
```

### 4.14 Verify Phase 4

```bash
# Full integration test
docker compose up -d
pnpm --filter @growthhog/api dev

# Enroll a user — should immediately advance through the first action node
curl -X POST http://localhost:3001/v1/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "event": "user.created",
    "userId": "test-user-2",
    "userEmail": "test2@example.com",
    "properties": { "plan": "free" }
  }'

# Expected:
# - enrolled: true
# - evaluations: [{ journeyId: "activation-welcome", advances: 2, completed: false }]
#   (advances through send_welcome action, then stops at wait_48h)

# Check the database directly:
# SELECT * FROM journey_states WHERE user_id = 'test-user-2';
#   → current_node should be "wait_48h"
#   → next_eval_at should be ~48 hours from now

# SELECT * FROM journey_logs WHERE user_id = 'test-user-2' ORDER BY created_at;
#   → Should show: entry → send_welcome (action) → wait_48h (advance)

# SELECT * FROM email_sends WHERE user_id = 'test-user-2';
#   → Should have 1 row with template_key = "activation/welcome"

# Now simulate the event that the condition node checks
curl -X POST http://localhost:3001/v1/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "event": "feature.used",
    "userId": "test-user-2",
    "properties": { "feature": "dashboard" }
  }'

# This stores the event. The condition node won't advance yet because
# the user is on a wait node (wait_48h), not the condition node.
# The condition will be evaluated when the wait expires.
```

---

## Summary of Package Dependencies

### `packages/journey-engine` dependencies

```
drizzle-orm
postgres
zod
```

### `packages/journey-engine` devDependencies

```
drizzle-kit
tsx
@types/node
@repo/typescript-config
```

### `apps/api` additional dependencies

```
@growthhog/journey-engine (workspace:*)
```

---

## What Comes Next (Phase 5+)

After these 4 phases are complete, the following remain:

| Phase | What |
|-------|------|
| 5 | pg-boss scheduler: poll journey_states every 60s, evaluate pending |
| 6 | Resend integration: React Email rendering, real email sending |
| 7 | Link rewriting + click tracking endpoint |
| 8 | Open tracking pixel endpoint |
| 9 | Suppression logic (frequency cap, daily cap, preferences check) |
| 10 | Unsubscribe endpoint + Resend webhook handler |
| 11 | PostHog event push-back |
| 12 | Admin/debug API endpoints |

The scheduler (Phase 5) is the next critical piece — it's what advances users through wait nodes when time elapses, without needing an inbound event.

---

## Common Commands Reference

```bash
# Start Postgres
docker compose up -d

# Generate migration from schema changes
DATABASE_URL="postgresql://growthhog:growthhog@localhost:5432/growthhog" \
  pnpm --filter @growthhog/journey-engine db:generate

# Run migrations
DATABASE_URL="postgresql://growthhog:growthhog@localhost:5432/growthhog" \
  pnpm --filter @growthhog/journey-engine db:migrate

# Quick-push schema (dev only, no migration file)
DATABASE_URL="postgresql://growthhog:growthhog@localhost:5432/growthhog" \
  pnpm --filter @growthhog/journey-engine db:push

# Visual schema browser
DATABASE_URL="postgresql://growthhog:growthhog@localhost:5432/growthhog" \
  pnpm --filter @growthhog/journey-engine db:studio

# Type check everything
pnpm check-types

# Lint everything
pnpm lint

# Start API dev server
pnpm --filter @growthhog/api dev

# Start all dev servers
pnpm dev
```
