# How to Launch & Demo the Workflow Module

A plain-English notepad. No coding needed — just copy-paste the commands and
click where it says to click.

The system has 2 jobs:
1. **Design templates** — a person types one out, or the AI writes a draft.
2. **Execute templates** — run the approved steps for a real case and produce a
   document, pausing for a human to approve along the way.

---

## PART 1 — Launch (turn everything on)

You need **4 things** running. Open a separate terminal window for each.

### 1. PostgreSQL (the filing cabinet / database)

Good news: this one **starts automatically when Windows starts**. It's already
running — do nothing.

If the API later complains it cannot connect (see Troubleshooting), open a
terminal **as Administrator** and run:

    net start postgresql-x64-18

### 2. Ollama (the AI brain, runs on this computer — no internet needed)

In a terminal:

    ollama serve

- Seeing `Error: listen tcp 127.0.0.1:11434 ... Only one usage of each socket address`
  is **good news** — it means Ollama is already running. Ignore it.
- Leave this window open (it's the AI's on-switch).

**Check it's alive:** open <http://127.0.0.1:11434> in the browser.
You should see: *Ollama is running*.

**One-time setup on a new machine** (skip if `ollama list` already shows the model):

    ollama list
    ollama pull qwen3.5:9b

The model is called **qwen3.5:9b** — the same one used by the CASE project this
module is based on. It's about 6 GB, downloaded once.

### 3. The API (the brain of our system — connects everything)

In a new terminal, from the project folder:

    cd template-module
    npm run dev:server

**Wait for these two lines:**

    Template API listening on http://127.0.0.1:8000
    Ollama: http://127.0.0.1:11434 (qwen3.5:9b)

Leave this window open.

**Check it's alive:** open <http://127.0.0.1:8000/api/templates> in the browser.
You should see a wall of text (JSON) — that's the data. If it shows an error
page, the API isn't up.

### 4. The website (the screens you'll actually show)

In another new terminal:

    cd template-module
    npm run dev:web

**Check it's alive:** open <http://localhost:5173>.
You should see **"Workflow Template Console"**.

---

## PART 2 — 60-second health check (do this before the presentation)

| Open in browser | Expected |
|---|---|
| <http://127.0.0.1:11434> | "Ollama is running" |
| <http://127.0.0.1:8000/api/templates> | wall of text |
| <http://localhost:5173> | "Workflow Template Console" |

Optional: run the test suite in a terminal (should say **51 passed**):

    cd template-module
    npm test

---

## PART 3 — The demo script (~15 minutes)

Browser: <http://localhost:5173>. Top-right there's a dropdown that says
**"Signed in as …"** — that's how you switch between people and their roles:

- **Aisyah — Admin** (does everything an operator can, plus invites people)
- **Aiman — Operator** (creates, edits, approves, runs)
- **Bagus — Operator** (a second operator — useful for "someone else decides")
- **Chong — Auditor** (can only look; cannot change or run anything)

You'll use that dropdown in Act 4 and Act 5. Start as **Aiman**.

### ACT 1 — Set the scene (30 seconds, talking only)

> "Right now, when a complaint comes in, someone fills in forms by hand, chases
> a supervisor for approval, and types the reply letter themselves. Today I'll
> show a system where the *procedure itself* is stored as a template — drafted
> by AI, approved by a human — and then *executed* automatically, producing the
> actual document."

### ACT 2 — A template drawn by a human (2 minutes)

1. Click **Templates** → **New manual template**.
2. Template name: `Maintenance Complaint Workflow`.
3. Add 4 steps (the **Add step** button), typing a name and description for
   each, and picking its type:
   1. `Review complaint` → type **review**
   2. `Check required details` → type **validation**
   3. `Obtain approval` → type **approval**
   4. `Notify the requester` → type **notification**
4. Click **Create template**.
5. Click on the template you just made to open it.

**Point at the screen and say:**
> "Origin says **MANUAL** — a human designed it. Status says **PENDING** and
> it's inactive: the system refuses to run *any* template until an operator or
> admin approves it. Even hand-made ones."

### ACT 3 — The AI drafts a template (3 minutes)

1. Click **Generate with AI**.
2. Paste this into the box:

    Create a workflow for a maintenance complaint submitted in Malay. Include
    reviewing the complaint, checking required details, obtaining approval if
    needed, and notifying the requester.

3. Click **Generate draft** and wait ~15–20 seconds (the button says
   "Generating with Ollama…").

**What you'll see:** a new template appears, with origin **AI DRAFTED**, status
**PENDING**, and 4 steps that match exactly what was asked — in plain language.

**Point at the screen and say:**
> "The AI turned a one-sentence request into a properly structured workflow.
> But look: it starts *pending and inactive*. The AI proposes — it cannot
> approve, it cannot activate, it cannot send anything. All of that was decided
> by our validation rules and approval flow, not by the model."

### ACT 4 — The system says "no" (2 minutes)

1. Switch the top-right dropdown to **Chong — Auditor**.
2. Click **Approve** on a pending template (either one).
3. **You'll see a red error: FORBIDDEN.** The server refused.
4. Switch the dropdown to **Bagus — Operator** and try again.
5. It works: status becomes **APPROVED / Active**, recorded against Bagus.

**Point at the screen and say:**
> "That first click failed because the *server* refused it — an auditor can
> only read, no matter what the buttons show. There are three roles: auditors
> read, operators create/approve/run, and admins also manage who gets which
> role. Permissions are enforced in the back end, and the approval is recorded
> against the person's identity."

### Optional beat — the admin whitelists a person (2 minutes)

1. Switch to **Aisyah — Admin** → the **Members** tab only appears for an admin.
2. Type an email, e.g. `farid.hakim@agency.gov.my`, leave the name empty (it is
   derived from the address), pick **auditor**, click **Invite**.
3. The member appears in the list and in the top-right dropdown. Switch to them:
   the create/approve buttons are gone — auditors can only look.
4. Back as **Aisyah**, change their role to **operator**: switch to them again and
   the controls are back.

> "Roles are not a UI trick: the very next request from that person is checked
> against the new role on the server."

Then show removal — the part that matters for safety:

5. As **Aisyah**, click **Remove access** on that member (confirm the prompt).
6. Their row shows **Access removed** and they disappear from the dropdown, so
   they can no longer sign in — try switching to them and the app reports the
   revocation.
7. Their name is still on everything they touched: open **Templates** and look at
   a template they created — `Created by` still names them.

> "We removed the person, not the evidence. The account is blocked, but every
> template, approval and run they were part of still carries their identity —
> that is what an audit trail means. And if they come back, inviting the same
> email restores the same person, with their history intact."

8. Optional: click **Restore access** on the row to bring them back.

### ACT 5 — Execute the workflow & generate the document (5 minutes)

1. Click **Runs** → **Start run**.
2. Pick the template you just approved (e.g. the AI-drafted one), fill in the
   case form with a real-sounding case:
   - complainant: `Nurul Aisyah`
   - location: `Block C, Level 2`
   - issue: `Air cond leaking`
3. Click **Start run**.

**Watch the timeline on the right:**
- Steps run one by one; you'll see green ticks.
- When it reaches **"Obtain approval"**, the whole run **pauses** and shows
  **PAUSED** — a human decision is required. It will wait here forever until a
  human answers.
- Switch to **Bagus — Operator**, and in the gate card click
  **Approve & continue**.
- The run continues and completes.

4. At the bottom of the run there's a **Generated document** card — click
   **Open document**.

**What you'll see:** a real document, opened in the browser, where the AI has
written a professional reply letter *using the case facts you typed* — Nurul
Aisyah, Block C Level 2, the leaking air con — plus the case data as an audit
table underneath. This takes ~20 seconds (the AI is writing it during the run).

**Point at the screen and say:**
> "That's the full story: AI drafted the procedure, a human approved it, the
> system executed it for a real case, a human approved the sensitive step, and
> the AI produced the final document — with every step, decision and identity
> recorded."

### ACT 6 — The closing line (30 seconds)

> "**AI proposes, humans decide, the system executes — and keeps the receipts.**
> Templates can't run without approval, approvals can't happen without
> permission, runs survive restarts, and no real notification is ever sent just
> because a template mentions one — that's shown as 'simulated' on purpose."

---

## PART 4 — Troubleshooting (plain English)

| Symptom | What it means | Fix |
|---|---|---|
| Browser says "refused to connect" on 5173 | The website isn't running | Run `npm run dev:web` in a terminal |
| Browser says "refused to connect" on 8000 | The API isn't running | Run `npm run dev:server`; look for "Template API listening" |
| API says "connection refused" / "password authentication failed" | The database isn't running | Terminal as Administrator: `net start postgresql-x64-18` |
| "Only one usage of each socket address" when running `ollama serve` | Ollama is *already* running — this is fine | Nothing; move on |
| AI generation takes forever | Normally 15–20s | Check `ollama list` shows `qwen3.5:9b`; if missing: `ollama pull qwen3.5:9b` |
| "Model not found" | The AI model isn't installed | `ollama pull qwen3.5:9b` |
| Red error "template not ACTIVE" when starting a run | You picked an unapproved template | Approve it as Bagus first |
| Want a completely clean demo | Old runs/templates cluttering the list | Ask your co-developer for a fresh database, or just ignore them — the old items actually help show the audit trail |

**The golden rule:** each terminal window keeps its thing alive. Close the
window → that thing dies. Keep all three open (Ollama, API, website).

**Where generated files land:** `template-module/server/output/documents/`
(each run's document is saved as a real file there too — handy as a backup if
the browser demo ever misbehaves).

---

## PART 5 — The glossary (if someone asks "what is that?")

- **Ollama** — free software that runs the AI on our own laptop. Nothing goes
  to the cloud; no data leaves the machine.
- **qwen3.5:9b** — the specific AI model (about 6 GB). The same one the CASE
  project uses. It writes the template drafts and drafts document text.
- **LangChain / LangGraph** — the toolbox that (a) connects our system to the
  AI, and (b) runs a workflow's steps in order, pausing safely at approvals and
  remembering where it was — even if the server restarts mid-run.
- **Template** — the stored recipe: the ordered steps of a process.
- **Run (instance)** — one execution of that recipe with real case data.
- **Approval gate** — a step where the system stops and waits for a human.
- **Origin vs Status** — two different things. *Origin* = who proposed it
  (MANUAL or AI DRAFTED). *Status* = what a human decided (Pending / Approved /
  Rejected). The AI only ever affects the first one.
- **Simulated notification** — templates can include a "notify" step, but the
  system deliberately does **not** send real emails or messages. It shows the
  step as "simulated" so nobody gets spammed by an AI's say-so.
