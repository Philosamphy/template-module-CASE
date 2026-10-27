# Demo Cheat Sheet — Workflow Template Module

Live walkthrough for co-developers: **AI proposes → humans validate/approve → execution
pauses at a human gate → survives a restart → finishes with an audit trail.**
~8 minutes, four acts.

---

## Services (check before you present)

| Service | URL | Check |
|---|---|---|
| API | http://127.0.0.1:8000 | `curl http://127.0.0.1:8000/api/health` → 200 |
| Web UI | http://localhost:5173 | browser opens the console |
| Ollama | http://127.0.0.1:11434 | `curl http://127.0.0.1:11434/api/tags` → lists `llama3` |
| Postgres | per `server/.env` | API health returns 200 (it checks on boot) |

**Start order if something is down** (Ollama auto-starts with Windows):

```bash
cd template-module
PORT=8000 npm run dev:server     # terminal 1 — API
npm run dev:web                  # terminal 2 — UI
```

> Note: run the API from a normal terminal. `PORT=8000` is only needed if your
> shell already has a `PORT` variable set — `server/.env` has `PORT=8000` normally.

---

## Staged demo state (in the database now)

| Artifact | ID | State | Used in |
|---|---|---|---|
| Fresh AI draft | `62f79fe7-d0ea-47b4-8b09-6e3a9b4aa196` | AI_DRAFTED / PENDING / inactive | Act 1–2 fallback |
| Approved template | `367da998-f03f-400f-b3b9-e62022c04f97` | APPROVED / active | Act 3 starts |
| **Paused instance** | `f21585f4-6d68-40f8-9789-9c9699c1db2a` | PAUSED at step-3 | Act 3 restart trick |
| Completed example | `d4c28de1-9542-4fe6-acfc-d8f65680d04a` | COMPLETED | finished audit trail |

All of it lives in Postgres — it survives restarts. That is the demo.

---

## Act 1 — AI proposes (2 min)

UI → **Generate with AI** → paste:

> Create a workflow for a maintenance complaint submitted in Malay. Include reviewing
> the complaint, checking required details, obtaining approval if needed, and
> notifying the requester.

→ **Generate draft** (~10 s real Llama 3 call).

**Say this:** the model was only asked for `{name, steps}` — it *cannot* express
origin, status, or activation — and the result is re-validated (Zod + business rules)
before it touches the database.

*Fallback if it fails live:* point at the pre-generated draft above — same code path,
already run this morning.

## Act 2 — Human approves (1 min)

Switch identity dropdown to **Bagus — Approver** → open the draft → **Approve & activate**.

*Optional flex:* first click Approve while signed in as **Aiman — Operator** →
**403 FORBIDDEN**. Permissions are enforced server-side, not by hiding buttons.

## Act 3 — Execution + the restart trick (3 min)

```bash
# 1. Start a run → returns PAUSED at step-3 (steps 1–2 auto-ran)
curl -s -X POST http://127.0.0.1:8000/api/instances \
  -H "content-type: application/json" -H "x-operator-id: ops-operator" \
  -d '{"templateId":"367da998-f03f-400f-b3b9-e62022c04f97"}'

# 2. Wrong role tries to open the gate → 403
curl -s -X POST http://127.0.0.1:8000/api/instances/f21585f4-6d68-40f8-9789-9c9699c1db2a/respond \
  -H "content-type: application/json" -H "x-operator-id: ops-operator" \
  -d '{"approved":true}'

# 3. THE MONEY SHOT: restart the API (Ctrl+C, then npm run dev:server again),
#    then prove nothing was lost:
curl -s -H "x-operator-id: ops-operator" \
  http://127.0.0.1:8000/api/instances/f21585f4-6d68-40f8-9789-9c9699c1db2a
#    → still "status":"PAUSED","currentStep":"step-3"

# 4. Approver opens the gate → COMPLETED
curl -s -X POST http://127.0.0.1:8000/api/instances/f21585f4-6d68-40f8-9789-9c9699c1db2a/respond \
  -H "content-type: application/json" -H "x-operator-id: ops-approver" \
  -d '{"approved":true,"comments":"Looks good."}'
```

Expected final state: `COMPLETED`, step-3 `APPROVED [ops-approver]`,
step-4 `SIMULATED` (`delivered: false` — **no real message is ever sent**).

*If the pre-paused instance gets consumed during rehearsal:* start a fresh one with
command 1 — it pauses at step-3 immediately.

## Act 4 — Proof it's real (2 min)

```bash
cd template-module && npm test     # 45 tests: schemas, business rules, HTTP lifecycle,
                                   # permissions, execution graph, rollback
```

Then point at the two artifacts: `server/src/execution/graph.ts` (the `interrupt()`
call) and the `step_runs` table (the audit trail).

---

## The honest-scope statement (expect these questions)

| Part | Status |
|---|---|
| Execution engine, pause/resume, restart survival | **Real**, Postgres-persisted |
| Authorization (403s), audit trail, transactions | **Real**, enforced server-side |
| AI generation via Ollama/Llama 3 | **Real**, ~10 s, re-validated as untrusted input |
| `review` / `validation` step handlers | **Placeholder logic** — they record a run but don't inspect content yet (planned: require a human) |
| `notification` step | **Simulated by design** — real adapter is a follow-up |
| Operator identity | **`x-operator-id` header**, not real sign-in yet |

One-sentence version: *"The engine, the gates and the persistence are real and tested;
the step handlers are placeholder implementations behind a port interface."*

---

## Don'ts before the demo

- **Don't run `npm install`** — it can prune packages and force a slow restart.
- **Don't delete the database** — everything staged above lives there.
- **If the API dies:** `PORT=8000 npm run dev:server`, check `/api/health`.
  Data is safe; paused instances will still be `PAUSED`.
- **If Ollama generation fails live:** retry once; if it still fails, use the
  pre-generated draft and move on — don't debug during the meeting.
