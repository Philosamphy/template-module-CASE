# Workflow Template Module

A template-creation module for approval-controlled workflows: operators either build a
template by hand or describe one in natural language, the backend validates it, and a
template only becomes usable after an authorised human approves it.

Stack: **React + TypeScript + Tailwind CSS** (operator console) · **Node.js + Express +
Zod + PostgreSQL** (API) · **LangChain + Ollama (Llama 3)** (AI drafting).

```
template-module/
├── server/           Express API (TypeScript, ESM)
│   ├── src/
│   │   ├── ai/            LangChain + Ollama generator
│   │   ├── auth/          operator identity + permission middleware
│   │   ├── db/            pool, migration runner, migrations/*.sql
│   │   ├── domain/        Zod schemas, business rules, errors
│   │   ├── execution/     LangGraph workflow execution (graph, notifier, types)
│   │   ├── repo/          repository interfaces + PostgreSQL implementations
│   │   ├── routes/        /api/templates and /api/instances routers
│   │   ├── services/      template lifecycle + instance execution logic
│   │   ├── app.ts         express wiring + error handler
│   │   └── index.ts       bootstrap (migrate, checkpointer setup, listen)
│   ├── tests/              vitest: schemas, template lifecycle, execution
│   └── .env.example
└── web/              React + Vite + Tailwind operator console
```

## Quick start

```bash
cd template-module
npm install
cp server/.env.example server/.env      # set DATABASE_URL, OLLAMA_* etc.
npm run migrate                         # applies migrations (idempotent)
npm run dev:server                      # http://localhost:8000
npm run dev:web                         # http://localhost:5173
```

AI drafting needs Ollama with Llama 3 available:

```bash
ollama pull llama3
ollama serve
```

Until Ollama is reachable, every other endpoint works normally — `/generate` returns
`502 AI_GENERATION_FAILED` instead of silently failing.

Verification:

```bash
npm run typecheck   # tsc for server (src + tests) and web
npm run build       # server dist + web dist
npm test            # 34 vitest tests: schemas, business rules, full HTTP lifecycle
```

## API

All routes sit behind `app.use("/api/templates", ...)`. Identity is read from the
`x-operator-id` header (`ops-operator`, `ops-approver` are seeded by the migration).

| Method | Endpoint | Permission | Purpose |
|---|---|---|---|
| POST | `/api/templates` | `template:create` | Create a manual template (server assigns UUID, `origin=MANUAL`) |
| GET | `/api/templates` | any operator | List, filterable by `?origin=`, `?status=`, `?is_active=` |
| POST | `/api/templates/generate` | `template:generate` | Generate an AI draft from a prompt |
| GET | `/api/templates/:id` | any operator | One template plus its full review history |
| PUT | `/api/templates/:id` | `template:edit` | Edit `name`/`steps` only |
| DELETE | `/api/templates/:id` | `template:deactivate` | Deactivate (`is_active=false`), never deletes the row |
| POST | `/api/templates/:id/approve` | `template:approve` | Approve **and** activate, transactionally |
| POST | `/api/templates/:id/reject` | `template:approve` | Reject (reason required), stays inactive |

Route order puts `/generate` before any generic `/:id` matcher.

### Execution — `/api/instances`

| Method | Endpoint | Permission | Purpose |
|---|---|---|---|
| POST | `/api/instances` | `workflow:start` | Start one run of an **APPROVED + active** template |
| GET | `/api/instances` | any operator | List runs (`?status=`, `?template_id=`) |
| GET | `/api/instances/:id` | any operator | One run plus every step that executed |
| POST | `/api/instances/:id/respond` | `workflow:respond` | Answer the paused approval gate (resume the graph) |
| POST | `/api/instances/:id/cancel` | `workflow:cancel` | Stop a run, keeping its history |

Errors always come back as `{ error: { code, message, details } }`, with
`details.structural` and `details.businessRules` populated on `422`. Stack traces, SQL and
credentials are logged server-side only.

## Validation: two layers, always both

**1. Structural (Zod)** — `domain/schemas.ts`

Name present and non-empty, `steps` a non-empty array, every step has
`id` / `name` / `type` / `description`, `type` is one of
`review | validation | approval | notification`, optional `assignedRole` and `channel`
are strings. Schemas are **strict**, so sending `origin`, `is_active`, `template_id` or
`review_status` in an edit request is a `422`, not a silent ignore.

**2. business rules** — `domain/businessRules.ts`

| Rule | Meaning |
|---|---|
| `max-steps` | ≤ `MAX_STEPS` (default 20) |
| `unique-step-ids` | step ids must be unique |
| `first-step-review` | the first step must be a `review` step |
| `approval-requires-validation` | an `approval` step must follow a `validation` step |
| `role-supported` | `assignedRole` must exist in `SUPPORTED_ROLES` |
| `notification-channel-supported` | `channel` must be in `SUPPORTED_NOTIFICATION_CHANNELS` |
| `notification-after-review` | a `notification` step never runs before the first `review` |

Rules run on creation, on every edit, **and again at approval/rejection time** — a valid
template is not an approved template.

## Lifecycle

```
origin = MANUAL | AI_DRAFTED      ← how it was made (never a review state)
status = PENDING → APPROVED | REJECTED   ← what a human decided
is_active = true only after APPROVAL
```

```
create / generate ──▶ PENDING + inactive
                        │        │
              approve ──┘        └── reject ──▶ REJECTED (inactive)
                        │                          │
                        ▼                     edit again
                    APPROVED + active  ◀── (re-submits as PENDING) ── PENDING
                        │
                    edit ──▶ 409 "create a new version instead"
```

## Workflow execution (LangGraph)

An approved template becomes a graph: one node per step, edges following step order,
keyed on `step.type`.

```
POST /api/instances  ──▶ graph.invoke({steps}, {thread_id: instanceId})
      run step-1 review ──▶ step-2 validation ──▶ step-3 approval ── interrupt() ── PAUSED
                                                                    │
POST /:id/respond     ──▶ graph.invoke(new Command({resume}))  ─────┘
      step-4 notification (simulated) ──▶ COMPLETED
```

- **State lives in PostgreSQL** via `PostgresSaver` (`thread_id` = instance id), so a
  paused workflow survives a server restart — verified live, not just in tests.
- **`interrupt()` comes before any side effect.** On resume, LangGraph restarts that node
  from the top; putting the pause first is what stops a rejected approval from having
  already fired the notification.
- **Steps are snapshotted at start**, so editing or re-approving a template never changes
  a run already in flight.
- **Notifications are simulated** by `SimulatedNotificationPort` — a template mentioning
  email/Telegram cannot cause a real message on its own. Swap in a real adapter when
  those integrations exist.
- **The AI model is not involved in execution.** Llama 3 proposes templates; running them
  is a deterministic state machine.
- `step_runs` is keyed `UNIQUE (instance_id, step_id)` and upserted, so a re-emitted event
  from a resumed node cannot create duplicates.

## Design decisions worth knowing

- **Both origins start `PENDING` and inactive.** The spec's manual-creation diagram ends at
  PostgreSQL, but "activated only after the necessary checks and approval succeed" applies
  to every template; origin and approval status stay separate either way.
- **AI output is untrusted input.** The model is asked only for `{ name, steps }` — the
  schema it is validated against literally cannot express `origin`, `is_active`, status or
  ids. It is re-checked structurally *and* against the business rules, then stored as
  `AI_DRAFTED` / `PENDING` / `is_active=false` with a `PENDING` review row in the **same
  transaction**. Nothing in the generate path can approve, activate or notify.
- **Approve/reject run in one transaction**: `SELECT … FOR UPDATE` on the template row →
  status must be `PENDING` → re-validate stored steps → insert the decision row (with
  `reviewed_by` from the authenticated operator) → set `is_active` → `COMMIT`. Any failure
  rolls the whole thing back, so a half-approved template cannot exist.
- **Rejected templates are editable** and editing re-submits them as `PENDING`; approved
  templates are locked (409) because silently mutating an approved workflow is worse than
  creating a new version.
- **`DELETE` is a soft delete.** The row, its steps and its review history stay for audit.
- **Rejection requires a reason** (`comments`, min 1 character); approval's is optional.

## Database

`workflow_templates` (UUID PK, `steps JSONB`, `origin`/`is_active`/`version`/`name` CHECK
constraints, `created_by → operators`) and `template_reviews` (append-only history, FK to
templates, status CHECK, `reviewed_by → operators`). The current status is simply the
latest review row (a `LEFT JOIN LATERAL`, so templates are never status-less).

Every query is parameterised (`pool.query` with `$1, $2, …`); credentials live only in
`DATABASE_URL`. Migrations are idempotent and recorded in `schema_migrations`.

## Security status — read this before production

Implemented: server-side permission checks on every mutating route (the UI only *reflects*
permissions), authenticated operator identity recorded on each decision, strict schemas
blocking protected fields, parameterised SQL, env-only credentials, AI output validated as
untrusted, simulated-only notifications, and an error handler that never leaks stacks or
connection strings.

Permissions in play: `template:create | generate | edit | deactivate | approve` and
`workflow:start | respond | cancel`. Operators may create, edit and start; **only the
approver role may approve/reject templates or answer a paused workflow gate** — enforced
in `auth/middleware.ts` on the server, regardless of what the UI shows.

**Not implemented yet** (needs your infrastructure):

1. **Real authentication.** Identity currently comes from the `x-operator-id` header
   resolved against the `operators` table. That is authorisation plumbing, not
   authentication — replace the lookup in `auth/middleware.ts` with session/JWT/OIDC
   verification before exposing this.
2. Rate limiting on `/generate` (every call burns Ollama CPU).
3. A dedicated audit table if you need tamper-evident history beyond `template_reviews`.
4. Version incrementing / "create new version" for approved templates (currently a 409).

## Notes

- **45 tests** pass (`npm test`): schemas, business rules, the template HTTP lifecycle and
  the execution suite (pause → restart → resume from a second service instance sharing the
  checkpointer).
- Exercised against real PostgreSQL too: constraints, transaction rollback, filters, and a
  live run where a workflow was paused, the API restarted, and it then completed from the
  persisted checkpoint.
- Ollama generation is exercised with a stub generator because no model server was
  reachable here; `FixedTemplateGenerator` is why the suite needs neither Ollama nor
  PostgreSQL.
- **Not built yet:** the operator UI for running workflows (instances list + "waiting for
  you" approval panel) and a real notification adapter.
- The demo preview runs on a throwaway embedded Postgres (port 55450, `.tmp-dev-pg/`).
  Heads-up: plain `npm install` prunes that unsaved package and will wedge the running
  demo database — reinstall with `npm install --no-save embedded-postgres` if it dies.
