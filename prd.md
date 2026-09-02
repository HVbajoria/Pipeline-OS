# PipelineOS — Complete Feature Documentation

This document specifies every feature in PipelineOS: what it does, who triggers it (human or agent), exact inputs/outputs, how data flows through the system, what state it mutates, and how it ties to the UI. Use this as the implementation reference alongside the build prompt.

---

## 0. Core Data Model (referenced throughout)

```
JobRequisition {
  id: string
  title: string
  department: string
  requirements: string[]        // e.g. ["5+ yrs backend", "Go or Rust", "distributed systems"]
  compBand: { min: number, max: number, currency: string }
  status: "open" | "paused" | "closed"
  createdBy: recruiterId
  createdAt: timestamp
}

Candidate {
  id: string
  name: string
  email: string
  resumeText: string
  skills: string[]
  experienceYears: number
}

Application {
  id: string
  candidateId: string
  jobId: string
  status: "applied" | "screened" | "interviewing" | "offer_sent" | "offer_accepted" | "offer_declined" | "rejected" | "onboarding"
  screeningScore: number | null          // 0-100
  screeningRationale: string | null
  notes: { author: string, text: string, at: timestamp }[]
  createdAt: timestamp
}

InterviewPanel {
  id: string
  jobId: string
  interviewers: { id: string, name: string, role: string }[]
}

Interview {
  id: string
  applicationId: string
  panelId: string
  slot: timestamp
  status: "proposed" | "booked" | "completed" | "cancelled"
}

Scorecard {
  id: string
  interviewId: string
  interviewer: string
  competencyScores: { [competency: string]: number }   // 1-5 each
  recommendation: "strong_yes" | "yes" | "no" | "strong_no"
  comments: string
  submittedAt: timestamp
}

Offer {
  id: string
  applicationId: string
  compAmount: number
  currency: string
  status: "draft" | "sent" | "accepted" | "declined" | "countered"
  counterAmount: number | null
  sentAt: timestamp | null
  respondedAt: timestamp | null
}

OnboardingTask {
  id: string
  offerId: string
  taskName: string
  status: "pending" | "in_progress" | "complete"
  dueDate: timestamp
}

BackgroundCheck {
  id: string
  offerId: string
  status: "pending" | "clear" | "flagged"
  initiatedAt: timestamp
  completedAt: timestamp | null
}

BenefitsEnrollment {
  id: string
  offerId: string
  planSelections: { medical: string, dental: string, vision: string }
  enrolledAt: timestamp
}
```

All tools read/write against this shared store. There is exactly one source of truth — the UI and the WebMCP tools both operate on the same objects, so an agent's tool call and a human's click produce identical downstream effects.

---

## PHASE A — Sourcing & Screening

### A1. `create_job_requisition`
**Actor:** Recruiter (human via form, or recruiter's agent via tool call)
**Preconditions:** None.

**Input:**
| field | type | required |
|---|---|---|
| title | string | yes |
| department | string | yes |
| requirements | string[] | yes |
| compBand | {min, max, currency} | yes |

**Data flow:**
1. Validate required fields present and `compBand.min <= compBand.max`.
2. Generate `id`, set `status: "open"`, `createdBy` from current session/role context, `createdAt: now()`.
3. Insert into `JobRequisition` store.
4. Emit an event to the Agent Activity Log: `{tool: "create_job_requisition", input, output: {jobId}}`.

**Output:** `{ jobId: string }`

**UI touchpoint:** Recruiter Dashboard → "New Requisition" form calls the same underlying function the tool calls (not a separate code path). New req appears at top of the pipeline kanban immediately.

**Errors:** `400` if requirements is empty array or compBand invalid.

---

### A2. `search_candidates`
**Actor:** Recruiter or recruiter's agent.

**Input:**
| field | type | required |
|---|---|---|
| query | string | no (free text, e.g. "backend engineer with Kubernetes experience") |
| skills | string[] | no |
| experienceLevel | "junior"\|"mid"\|"senior" | no |

**Data flow:**
1. Load full `Candidate` table.
2. Score each candidate: skill-overlap (Jaccard similarity between `skills` and query-derived skill tokens) + experience-level match bonus.
3. Sort descending by score, return top 10 with a short rationale string per candidate (e.g. "4/5 required skills matched: Go, Kubernetes, gRPC, distributed systems").
4. No state mutation — this is a read-only query tool.

**Output:** `{ results: [{ candidateId, name, matchScore, rationale }] }`

**UI touchpoint:** Recruiter Dashboard → "Source Candidates" panel, same scoring function backs both the search box and the tool.

---

### A3. `get_candidate_profile`
**Actor:** Recruiter, hiring manager, or their agents.
**Input:** `{ candidateId }`
**Data flow:** Direct read from `Candidate` store, joined with all `Application` records for that candidate (so the caller sees full history across jobs).
**Output:** Full candidate object + application history array.
**UI touchpoint:** Candidate detail panel (click any candidate card).

---

### A4. `submit_application`
**Actor:** Candidate or candidate's agent.
**Preconditions:** `jobId` must exist and have `status: "open"`.

**Input:**
| field | type | required |
|---|---|---|
| candidateId | string | yes |
| jobId | string | yes |
| resumeText | string | yes (may be tailored per-role by the candidate's agent) |

**Data flow:**
1. Check no existing `Application` for this `(candidateId, jobId)` pair — reject duplicate applications.
2. Create `Application` with `status: "applied"`, `screeningScore: null`.
3. Append to candidate's `resumeText` history if different from stored resume (so recruiters can see tailoring).
4. Insert into `Application` store; this immediately appears in the recruiter's kanban "Sourced/Applied" column.

**Output:** `{ applicationId: string, status: "applied" }`

**UI touchpoint:** Candidate Portal → "Apply" button on a job listing; Recruiter kanban updates in real time (poll or websocket).

**Errors:** `409` if duplicate application exists; `404` if jobId not found.

---

### A5. `screen_candidate`
**Actor:** Recruiter's agent (typically automated, though a human can trigger it manually too).
**Input:** `{ applicationId }`

**Data flow:**
1. Load `Application` → get `candidateId` and `jobId`.
2. Load `Candidate.skills` and `JobRequisition.requirements`.
3. Compute structured score: percentage of requirements matched (string/keyword overlap), weighted by `experienceYears` vs. implied seniority in requirements text.
4. Write `screeningScore` and `screeningRationale` (e.g. "7/9 requirements matched; 2 years experience gap on distributed systems") back onto the `Application`.
5. Update `Application.status` to `"screened"`.
6. This is intentionally **not** free-text LLM opinion — it's a computed, explainable score, so it's auditable and consistent whether a human or an agent triggers it.

**Output:** `{ applicationId, screeningScore, screeningRationale, status: "screened" }`

**UI touchpoint:** Kanban card moves from "Applied" to "Screened" column; score badge appears on the card.

---

### A6. `answer_candidate_faq`
**Actor:** Candidate's agent, on behalf of a candidate researching a role.
**Input:** `{ jobId, question }`

**Data flow:**
1. Load `JobRequisition` for the given `jobId`.
2. Answer is composed *only* from requisition fields (title, department, requirements, compBand range) — no hallucinated company info. If the question can't be answered from available data, return a flag rather than guessing.

**Output:** `{ answer: string, answeredFromData: boolean }`

**UI touchpoint:** Job listing page → "Ask about this role" widget, same function backs both.

---

## PHASE B — Scheduling & Interviewing

### B1. `check_interviewer_availability`
**Actor:** Recruiter or recruiter's agent.
**Input:** `{ panelId, dateRange: {start, end} }`
**Data flow:** Reads a mocked availability calendar per interviewer (seed with a simple weekly free/busy grid per interviewer id). Intersects free slots across all interviewers on the panel within `dateRange`.
**Output:** `{ commonFreeSlots: timestamp[] }`
**UI touchpoint:** Scheduling panel calendar view.

### B2. `propose_interview_slots`
**Actor:** Recruiter's agent.
**Input:** `{ applicationId }`
**Data flow:**
1. Resolve `jobId` from `applicationId` → resolve `InterviewPanel` for that job.
2. Call the same logic as B1 internally, take top 3 slots.
3. Create `Interview` records with `status: "proposed"` for each candidate slot (or a single record with 3 slot options — pick one modeling approach and keep it consistent).
**Output:** `{ proposedSlots: [{ interviewId, slot }] }`
**UI touchpoint:** Candidate Portal shows "Pick your interview time" with these 3 options.

### B3. `book_interview`
**Actor:** Candidate or candidate's agent (confirming one of the proposed slots) — or recruiter finalizing directly.
**Input:** `{ applicationId, slot }`
**Data flow:**
1. Find the matching proposed `Interview` record for that slot.
2. Set its `status: "booked"`; cancel the other proposed options for the same application (`status: "cancelled"`).
3. Update `Application.status` to `"interviewing"`.
**Output:** `{ interviewId, status: "booked" }`
**UI touchpoint:** Both recruiter and candidate calendars update; kanban card moves to "Interviewing".

### B4. `get_interview_kit`
**Actor:** Hiring manager or interviewer (human, reading before an interview) or their agent prepping notes.
**Input:** `{ jobId }`
**Data flow:** Read-only. Returns a static-per-role structured question set keyed by competency (seed 3-4 competencies per role template, e.g. "System Design", "Coding", "Collaboration").
**Output:** `{ competencies: [{ name, questions: string[] }] }`
**UI touchpoint:** Interviewer's pre-interview prep screen.

### B5. `submit_interview_feedback`
**Actor:** Hiring manager / interviewer (primarily human-in-the-loop; can also be agent-submitted if reading from notes).
**Input:** `{ interviewId, interviewer, competencyScores: {}, recommendation, comments }`
**Data flow:**
1. Validate `interviewId` exists and `status: "booked"` or `"completed"`.
2. Create `Scorecard` record.
3. Set `Interview.status = "completed"`.
**Output:** `{ scorecardId }`
**UI touchpoint:** Post-interview feedback form.

### B6. `get_panel_feedback_summary`
**Actor:** Recruiter or hiring manager, deciding whether to extend an offer.
**Input:** `{ applicationId }`
**Data flow:** Join all `Scorecard`s across all `Interview`s tied to the application; compute average competency scores and a recommendation tally (e.g. "3 strong_yes, 1 no").
**Output:** `{ averageScores: {}, recommendationTally: {}, scorecards: [...] }`
**UI touchpoint:** Candidate detail panel → "Interview Summary" tab.

---

## PHASE C — Offer & Post-Offer

### C1. `generate_offer`
**Actor:** Recruiter or recruiter's agent, after reviewing B6 summary.
**Input:** `{ applicationId, compAmount }`
**Data flow:**
1. Validate `compAmount` falls within the job's `compBand` (warn, don't hard-block, if outside — real orgs sometimes exception this).
2. Create `Offer` with `status: "draft"`.
**Output:** `{ offerId, status: "draft" }`
**UI touchpoint:** "Generate Offer" button on candidate detail panel, pre-fills comp band as a guide.

### C2. `send_offer`
**Actor:** Recruiter or agent.
**Input:** `{ offerId }`
**Data flow:** Set `Offer.status = "sent"`, `sentAt = now()`. Update `Application.status = "offer_sent"`.
**Output:** `{ offerId, status: "sent" }`
**UI touchpoint:** Candidate Portal shows offer notification/banner.

### C3. `respond_to_offer`
**Actor:** Candidate or candidate's agent.
**Input:** `{ offerId, decision: "accept"|"decline"|"counter", counterAmount? }`
**Data flow:**
1. If `accept`: `Offer.status = "accepted"`, `Application.status = "offer_accepted"`.
2. If `decline`: `Offer.status = "declined"`, `Application.status = "offer_declined"`.
3. If `counter`: `Offer.status = "countered"`, `Offer.counterAmount = counterAmount` — leaves it for the recruiter to call `generate_offer` again or re-send.
4. `respondedAt = now()` in all cases.
**Output:** `{ offerId, status }`
**UI touchpoint:** Recruiter dashboard gets a notification; candidate sees confirmation screen.

### C4. `initiate_background_check`
**Actor:** Recruiter or agent, only callable after `Offer.status == "accepted"`.
**Input:** `{ offerId }`
**Data flow:**
1. Validate precondition.
2. Create `BackgroundCheck` with `status: "pending"`.
3. Mock async resolution: after a short simulated delay (or immediately for demo purposes), flip to `"clear"` (seed data should make this deterministic for the demo).
**Output:** `{ backgroundCheckId, status }`
**UI touchpoint:** Onboarding tracker shows "Background Check: Pending/Clear" badge.

### C5. `enroll_benefits`
**Actor:** Candidate or agent.
**Input:** `{ offerId, planSelections: {medical, dental, vision} }`
**Data flow:** Validate each selection against a small static plan catalog. Create `BenefitsEnrollment` record.
**Output:** `{ enrollmentId }`
**UI touchpoint:** Candidate Portal → "Benefits" tab, plan comparison table + submit.

### C6. `generate_onboarding_checklist`
**Actor:** Recruiter or agent, after offer acceptance.
**Input:** `{ offerId }`
**Data flow:**
1. Resolve role from `Offer → Application → JobRequisition`.
2. Load a role-based task template (seed 2-3 templates: engineering, generic).
3. Bulk-create `OnboardingTask` records with computed `dueDate`s relative to a start date.
**Output:** `{ tasks: [{ taskId, taskName, dueDate }] }`
**UI touchpoint:** Onboarding checklist view, both recruiter and new hire can see/check off tasks.

### C7. `get_onboarding_status`
**Actor:** Recruiter, new hire, or either's agent — read-only progress check.
**Input:** `{ offerId }`
**Data flow:** Join `BackgroundCheck`, `BenefitsEnrollment`, and `OnboardingTask` records for the offer; compute completion percentage.
**Output:** `{ backgroundCheckStatus, benefitsEnrolled: boolean, taskCompletion: { done, total } }`
**UI touchpoint:** Dashboard summary card — "New hire is 60% through onboarding."

---

## Cross-cutting: Agent Activity Log

Every tool call (regardless of caller) writes one entry:
```
ActivityLogEntry {
  id, toolName, actorType: "human_ui" | "agent",
  actorId, input, output, timestamp
}
```
This is rendered as a live-updating feed component on every page. It's the single most important feature for the demo — it's the visible proof that the agent and the human are hitting the exact same code path, not a fake parallel system.

---

## State machine summary (Application lifecycle)

```
applied → screened → interviewing → offer_sent → offer_accepted → onboarding
                                    ↘ offer_declined
                    ↘ rejected (recruiter can set at any pre-offer stage)
```

Enforce this transition table server-side so neither a human click nor an agent tool call can skip a state illegally (e.g. can't `send_offer` on an application still in `"applied"`).

---

## Implementation note on shared code paths

For every feature above, implement **one function** (e.g. `screenCandidate(applicationId)`) that:
1. Is called directly by the WebMCP tool handler.
2. Is called directly by the UI's onClick/onSubmit handler.

Do not implement separate logic for "the tool version" and "the UI version" — that's the single biggest risk to WebMCP-leverage credibility in judging, since it's easy to fake a demo where the agent's tool calls don't actually touch real state.


---

## P14–P18 implementation addendum (September 2026)

The implementation now completes the public-prospect, trace, coordination, capability, compatibility, and release-validation expansion described by the later phases of this document. The canonical registry contains **32 operations**: the original 20 workflow operations plus 12 additive read/plan/approval/provenance/coordination entries. `src/shared/operations.ts` is the only registry; `OperationService`, the HTTP route, `OperationClient`, Documentation, and every WebMCP adapter consume the same descriptors and schemas.

### Public-prospect provenance and consent (P14)

Public GitHub search is an on-demand, recruiter-authorized read path and remains non-importing by default. `import_public_prospect` requires an allowlisted source reference, explicit consent scope/reference, and human approval; it stores safe provenance, field origins, attribution, and retention metadata without copying private contact data or synthesizing a resume. `revoke_public_prospect_consent` is terminal and idempotent, blocks reuse without new consent/version, and preserves a safe withdrawal audit fact. `applyPublicProspectRetention(state, now)` is an explicit host-scheduled hook: expired records are marked safely, consent-created candidates are removed only when unlinked, and preexisting candidates are retained without raw evidence entering projections.

### Correlated traces and actor-scoped synchronization (P15)

Canonical envelope invocations persist one bounded root activity trace with safe child spans, correlation/trace/span links, phase, approval, replay, stale, and redaction markers. Legacy `(name, input, actor)` calls retain their six-field activity shape. `/api/state` is a trusted-principal/resource-scoped projection, `/api/events` carries only revision hints, and UI/WebMCP clients refresh authoritative state after success and failure while preventing stale responses from regressing the store. Trace and provenance payloads are redacted before state serialization.

### Coordinated workflows and capability discovery (P16–P17)

`coordinate_interview_workflow` and `coordinate_onboarding_workflow` reuse the low-level scheduling/lifecycle commands in one atomic service operation and expose deterministic proposal, booking, checklist, and task-status outcomes through the UI and WebMCP. `discover_capabilities` evaluates all 32 descriptors against the same policy used at execution time and returns safe actor/resource scope, execution mode, approval, and redaction metadata; it is informational and never replaces execute-time authorization. Candidate, hiring-manager, recruiter, and delegated-agent projections are resource-scoped, and unknown or forged principals fail closed.

### Compatibility and release boundary (P18)

Legacy operation overloads, canonical `{ input }` requests, low-level HTTP aliases, six-field legacy activity records, unscoped local `serializeSharedState(state)`, seeded demo data, and monotonic reset revisions remain supported. Canonical calls may carry correlation, idempotency, expected-revision, approval, and parent-span metadata through the body or equivalent headers. Responses expose safe correlation/trace/replay headers; validation, denial, conflict, stale, and upstream failures use the shared structured error envelope. Durable hosts must schedule retention cleanup and replace the in-memory repository/ledger and demo actor resolver with durable storage and a trusted identity provider before production use.

The completed P14–P18 validation gate includes diagnostics/type checking, focused P12–P17 contract and role-matrix suites, lint, build, the full Vitest suite, compatibility-route checks, WebMCP registration checks, actor-scope/privacy review, and `git diff --check`. No commit or push is part of this implementation task.