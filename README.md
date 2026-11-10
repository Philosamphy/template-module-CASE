# Workflow Template Module

A template-creation module for approval-controlled workflows: operators either build a
template by hand or describe one in natural language, the backend validates it, and a
template only becomes usable after an authorised human approves it.

Stack: **React + TypeScript + Tailwind CSS** (operator console) · **Node.js + Express +
Zod + PostgreSQL** (API) · **LangChain + Ollama (Qwen 3.5 9B)** (AI drafting) · **LangGraph**
(deterministic workflow execution).

```
template-module/
├── server/           Express API (TypeScript, ESM)
│   ├── src/
│   │   ├── ai/            LangChain + Ollama generator
│   │   ├── auth/          operator identity + permission middleware
│   │   ├── db/            pool, migration runner, migrations/*.sql
│   │   ├── domain/        Zod schemas, business rules, errors
│   │   ├── execution/     LangGraph execution (graph, notifier, documents, types)
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

AI drafting needs Ollama with the CASE platform's model (Qwen 3.5 9B) available:

```bash
ollama pull qwen3.5:9b
ollama serve
```

Until Ollama is reachable, every other endpoint works normally — `/generate` returns
`502 AI_GENERATION_FAILED` instead of silently failing.

Verification:

```bash
npm run typecheck   # tsc for server (src + tests) and web
npm run build       # server dist + web dist
npm test            # 69 vitest tests: schemas, business rules, HTTP lifecycle, execution, roles
```

See `DEMO.md` for a staged walkthrough (services checklist, copy-paste commands, the
restart trick).

## API

All routes sit behind `app.use("/api/templates", ...)`. Identity is read from the
`x-operator-id` header, which accepts either a member id or a whitelisted email
(`ops-admin`, `ops-operator`, `ops-auditor` are seeded by the migrations).

### Roles

| Role | Can | Cannot |
|---|---|---|
| `auditor` | view templates, runs and generated documents (`template:read`, `workflow:read`) | create/edit/approve/deactivate templates, start/answer/cancel runs, invite anyone |
| `operator` | create, edit, deactivate and **approve** templates; start, answer and cancel runs | invite members or change roles |
| `admin` | everything an operator can do, plus invite operators/auditors and switch a member between those two roles (`users:manage`) | — |

`GET /api/operators/me` returns the caller's role and permission list; the UI uses it to
show or hide controls, and the server re-checks every one of those permissions itself.

| Method | Endpoint | Permission | Purpose |
|---|---|---|---|
| POST | `/api/templates` | `template:create` | Create a manual template (server assigns UUID, `origin=MANUAL`) |
| GET | `/api/templates` | `template:read` | List, filterable by `?origin=`, `?status=`, `?is_active=` |
| POST | `/api/templates/generate` | `template:generate` | Generate an AI draft from a prompt |
| GET | `/api/templates/:id` | `template:read` | One template plus its full review history |
| PUT | `/api/templates/:id` | `template:edit` | Edit `name`/`steps` only |
| DELETE | `/api/templates/:id` | `template:deactivate` | Deactivate (`is_active=false`), never deletes the row |
| POST | `/api/templates/:id/approve` | `template:approve` | Approve **and** activate, transactionally |
| POST | `/api/templates/:id/reject` | `template:approve` | Reject (reason required), stays inactive |

Route order puts `/generate` before any generic `/:id` matcher.

Member management lives under `/api/operators` (all routes require an identity):

| Method | Endpoint | Permission | Purpose |
|---|---|---|---|
| GET | `/api/operators/me` | any member | Caller's identity, role and permission list |
| GET | `/api/operators` | any member | The directory: id, name, email, role, `revokedAt` |
| POST | `/api/operators` | `users:manage` (admin) | Whitelist an email as `operator` or `auditor` |
| PATCH | `/api/operators/:id/role` | `users:manage` (admin) | Switch a member between `operator` and `auditor` |
| DELETE | `/api/operators/:id` | `users:manage` (admin) | Remove access (soft delete: `revokedAt` is set) |

An admin cannot change their own role or remove their own access, and `admin` itself is
neither invitable nor assignable here — it is provisioned outside the module (seed or
identity provider).

**Access is a whitelist.** Inviting an email is what grants access; the address itself
becomes a valid identity. Removing access is a *soft delete*: the member row stays, so
`created_by`, `reviewed_by` and `performed_by` keep naming the real person — templates,
reviews and runs are never orphaned or deleted. A revoked identity gets
`403 ACCESS_REVOKED` on every route. Inviting the same email again **restores that same
member id**, so their history reattaches rather than duplicating.

### Execution — `/api/instances`

| Method | Endpoint | Permission | Purpose |
|---|---|---|---|
| POST | `/api/instances` | `workflow:start` | Start one run of an **APPROVED + active** template; optional `input` map supplies the case data |
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
`review | validation | approval | document | notification`, optional `assignedRole` and
`channel` are strings. Schemas are **strict**, so sending `origin`, `is_active`,
`template_id` or `review_status` in an edit request is a `422`, not a silent ignore.

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
POST /api/instances {input} ──▶ graph.invoke({steps, input}, {thread_id: instanceId})
      run step-1 review ──▶ step-2 validation ──▶ step-3 approval ── interrupt() ── PAUSED
                                                                    │
POST /:id/respond     ──▶ graph.invoke(new Command({resume}))  ─────┘
      step-4 document (file written) ──▶ step-5 notification (simulated) ──▶ COMPLETED
```

- **State lives in PostgreSQL** via `PostgresSaver` (`thread_id` = instance id), so a
  paused workflow survives a server restart — verified live, not just in tests.
- **`interrupt()` comes before any side effect.** On resume, LangGraph restarts that node
  from the top; putting the pause first is what stops a rejected approval from having
  already fired the notification.
- **Steps are snapshotted at start**, so editing or re-approving a template never changes
  a run already in flight.
- **`document` steps are AI-drafted.** Starting a run accepts an `input` map
  (≤50 string fields, stored as JSONB); when execution reaches a `document` step, the
  content drafter (`OllamaDocumentContentGenerator` — the CASE platform's
  document-designer prompt with structured output) asks the model for a
  title/subtitle/sections/table built from that input, and the renderer writes a
  self-contained HTML file into `DOCUMENT_OUTPUT_DIR` (default
  `server/output/documents/`), recording `step_runs.result.file` plus
  `result.contentSource` — `ai`, or `input` when the model was unreachable and the
  renderer fell back (a run never fails because Ollama is down). The model can never
  choose the file name: paths stay derived from instance/step ids. The renderer sits
  behind `DocumentPort` (`src/execution/documents.ts`) — swap in a PDF/DOCX adapter
  without touching the graph. Nothing is uploaded or emailed; the artifact stays on disk.
- **Notifications are simulated** by `SimulatedNotificationPort` — a template mentioning
  email/Telegram cannot cause a real message on its own. Swap in a real adapter when
  those integrations exist.
- **The AI model is not involved in execution.** Qwen 3.5 proposes templates; running them
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
constraints, `created_by → operators`), `template_reviews` (append-only history, FK to
templates, status CHECK, `reviewed_by → operators`), `workflow_instances` (step snapshot,
status, cursor, `input JSONB`) and `step_runs` (one row per executed step, upserted on
`(instance_id, step_id)`). The current template status is simply the latest review row (a
`LEFT JOIN LATERAL`, so templates are never status-less).

Every query is parameterised (`pool.query` with `$1, $2, …`); credentials live only in
`DATABASE_URL`. Migrations are idempotent and recorded in `schema_migrations`.

## Security status — read this before production

Implemented: server-side permission checks on every mutating route (the UI only *reflects*
permissions), authenticated operator identity recorded on each decision, strict schemas
blocking protected fields, parameterised SQL, env-only credentials, AI output validated as
untrusted, simulated-only notifications, HTML-escaped document rendering, and an error
handler that never leaks stacks or connection strings.

Permissions in play: `template:read | create | generate | edit | deactivate | approve`,
`workflow:read | start | respond | cancel`, and `users:manage`. Operators hold all of the
template and workflow permissions (including approval); admins additionally hold
`users:manage`; auditors hold `template:read` and `workflow:read` only — enforced in
`auth/middleware.ts` on the server, regardless of what the UI shows.

**Not implemented yet** (needs your infrastructure):

1. **Real authentication.** Identity currently comes from the `x-operator-id` header
   resolved against the `operators` table. That is authorisation plumbing, not
   authentication — replace the lookup in `auth/middleware.ts` with session/JWT/OIDC
   verification before exposing this.
2. Rate limiting on `/generate` (every call burns Ollama CPU).
3. A dedicated audit table if you need tamper-evident history beyond `template_reviews`.
4. Version incrementing / "create new version" for approved templates (currently a 409).

## Notes

- **69 tests** pass (`npm test`): schemas, business rules, the template HTTP lifecycle,
  the execution suite and the role matrix (auditor read-only, operator write, admin member
  management: email whitelisting, role switching, revocation and restore) — including a document-step test that generates a real file from
  supplied input, and the pause → restart → resume flow from a second service instance
  sharing the checkpointer.
- Exercised against real PostgreSQL too: constraints, transaction rollback, filters, and a
  live run where a workflow was paused, the API restarted, and it then completed from the
  persisted checkpoint.
- Ollama generation was verified live against `qwen3.5:9b` (a `201` in ~14s, thinking disabled); the test suite
  itself uses a stub generator (`FixedTemplateGenerator`), so it needs neither Ollama nor
  PostgreSQL.
- **Not built yet:** the operator UI for running workflows (instances list + "waiting for
  you" approval panel), an `input` form on the start-workflow screen, and a real
  notification adapter.
