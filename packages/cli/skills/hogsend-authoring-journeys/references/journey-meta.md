# JourneyMeta — trigger, entryLimit, exitOn, suppress

`meta` is the static declaration of who enters a journey, how often, and what
pulls them out. It is the `JourneyMeta` type from `@hogsend/core`:

```ts
interface JourneyMeta {
  id: string;                 // stable unique id — used for state + ENABLED_JOURNEYS
  name: string;               // human label (becomes user.journeyName)
  description?: string;
  enabled: boolean;           // master on/off for this journey

  trigger: {
    event: string;            // the event name that enrolls a user
    where?: PropertyCondition[]; // optional gate on event properties
  };

  entryLimit: "once" | "once_per_period" | "unlimited";
  entryPeriod?: DurationObject; // required-in-practice for once_per_period

  exitOn?: Array<{
    event: string;
    where?: PropertyCondition[];
  }>;

  suppress: DurationObject;   // declared cool-down (required field; see note)
}
```

## Fields in detail

### `trigger.event`

The event name that enrolls a user. Each journey declares `onEvents:
[trigger.event]` on its Hatchet durable task, so when `POST /v1/ingest` (or a
webhook source) pushes that event, Hatchet routes it straight to this journey.
Use a constant from your `src/journeys/constants/`:

```ts
trigger: { event: Events.USER_CREATED },
```

### `trigger.where` (optional)

A `PropertyCondition[]` evaluated against the **enrolling event's properties**.
If present and not met, the event is skipped with reason
`trigger_conditions_not_met`. Use it to enroll only a slice of an event:

```ts
trigger: {
  event: Events.USER_CREATED,
  where: [{ property: "plan", operator: "equals", value: "pro" }],
},
```

For the full operator set and how `PropertyCondition` is shaped, see the
**hogsend-conditions** skill.

### `entryLimit` + `entryPeriod`

Controls re-entry:

- `"once"` — a user can ever enter this journey exactly one time. A second
  matching event is skipped (`already_entered_once`). Checked against ALL prior
  states for the user+journey, regardless of completion.
- `"once_per_period"` — re-entry allowed only after `entryPeriod` has elapsed
  since the user's most recent enrollment. Defaults to `hours(24)` if
  `entryPeriod` is omitted, so set it explicitly:
  ```ts
  entryLimit: "once_per_period",
  entryPeriod: days(7),
  ```
- `"unlimited"` — every matching event enrolls (subject to the active-state
  guard below). Good for test/smoke journeys.

### `exitOn` (optional)

Events that pull a user OUT of any in-flight run of this journey. Evaluated by
the ingestion pipeline whenever a new event arrives for a user with an active
journey state — if the incoming event name matches an `exitOn` rule (and its
optional `where` passes), the active run is exited:

```ts
exitOn: [
  { event: Events.USER_DELETED },
  { event: "subscription.cancelled", where: [{ property: "reason", operator: "equals", value: "churn" }] },
],
```

### `suppress`

A **required** `DurationObject` field declaring an intended cool-down before
re-entry. Note: the engine's enrollment gates do NOT currently read `suppress` —
actual re-entry timing is enforced by `entryLimit` + `entryPeriod` (above). It is
stored as journey metadata and surfaced on the admin journeys API. Treat it as
the declarative cool-down you pair with `entryLimit` (e.g.
`entryLimit: "once_per_period"`, `entryPeriod: days(7)`, `suppress: hours(12)`);
use `hours(0)` on `"unlimited"` test journeys. Because it is required, always set
it — `hours(0)` when you mean "none".

### `enabled`

Master switch. `enabled: false` makes every enrollment skip with reason
`journey_disabled`. (Admins can ALSO disable a journey at runtime via a
`journeyConfigs` override — that yields `journey_disabled_by_admin`. Toggle that
at runtime with the **hogsend-cli** skill's `journeys enable/disable`.)

## The 4-gate enrollment order

When the trigger event arrives, the journey task runs these gates IN ORDER
before `run()` executes. Any failing gate returns `{ status: "skipped", reason }`
and creates NO state:

1. **`meta.enabled`** (and the admin `journeyConfigs` override) →
   `journey_disabled` / `journey_disabled_by_admin`.
2. **`trigger.where`** against the event properties → `trigger_conditions_not_met`.
3. **`entryLimit`** (`checkEntryLimit`) → `already_entered_once` /
   `period_not_elapsed`.
4. **Email preferences** (`checkEmailPreferences`) — if the user is unsubscribed
   from all → `user_unsubscribed`.

After the gates, an **active-state guard** prevents concurrent enrollment: if a
state in status `active` or `waiting` already exists for this user+journey, the
event is skipped (`already_active`). This is why a single user never has two
overlapping runs of the same journey.

## State transitions

A `journeyStates` row tracks each run. Once the gates pass:

- **enter** → row created with `status: "active"`, `currentNodeId: "start"`.
- **`ctx.sleep` / `ctx.sleepUntil` / `ctx.waitForEvent`** → `status: "waiting"`
  while suspended, back to `"active"` on resume.
- **`run()` returns** → `status: "completed"`, `completedAt` set, and a
  `journey:completed` event is pushed.
- **`run()` throws** → `status: "failed"`, `errorMessage` recorded, and a
  `journey:failed` event is pushed; the error re-throws so Hatchet sees the
  failure.
- **`exitOn` matches (or cancelled)** → `status: "exited"`. If it happens while
  the journey is suspended in a `ctx.sleep`/`ctx.waitForEvent`, the durable run
  is cancelled so no further step runs — even mid-wait.

Because the gates run before any state is created, a skipped event is invisible
in `journeyStates` — to debug "why didn't this user enroll?", check the gate
order above and inspect events with the **hogsend-cli** skill.
