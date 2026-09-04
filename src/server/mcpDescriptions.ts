/**
 * Agent-facing tool guidance for the remote MCP endpoint.
 *
 * The canonical `OPERATION_REGISTRY` descriptions are intentionally short and
 * documentation-oriented. When the same operations are exposed to a remote LLM
 * host such as ChatGPT, the model benefits from action-oriented text that
 * states who calls the tool, when to reach for it, what it needs, what it
 * returns, and how it sequences with other tools.
 *
 * This module holds ONLY presentation guidance. It never changes the canonical
 * registry, schemas, capabilities, or approval policy, and it is consumed only
 * by the MCP transport adapter. The documentation view and WebMCP surface keep
 * the canonical descriptions.
 */

import type { OperationName } from '../shared/operations';

/**
 * How a mutating tool should be confirmed before it takes effect. Read-only
 * tools do not need confirmation. `plan` tools are routed through the approval
 * workflow (plan -> approve -> commit). `direct` mutations are applied
 * immediately by the service, so the agent should confirm with the human
 * first when the action is consequential (for example sending an offer).
 */
export type McpConfirmationMode = 'none' | 'confirm' | 'plan' | 'consent_and_plan';

export interface McpToolGuidance {
  /** One or two sentences written for the model, not for docs. */
  summary: string;
  /** Explicit confirmation expectation surfaced in annotations. */
  confirmation: McpConfirmationMode;
}

/**
 * Shared, reusable guidance fragments so the confirmation wording stays
 * consistent across every sensitive tool.
 */
export const MCP_CONFIRMATION_GUIDANCE: Record<McpConfirmationMode, string> = {
  none: '',
  confirm:
    'This changes records immediately. Confirm the details with the person you are acting for before calling it.',
  plan:
    'Do not call this directly for a real change. Stage it with plan_operation, show the returned approval card to the human, and only proceed after a recruiter approves it with approve_operation_plan and you commit it with commit_operation_plan.',
  consent_and_plan:
    'Requires explicit consent from the person whose data is used AND human approval. Capture consent, stage with plan_operation, and complete the approve/commit workflow before it takes effect.'
};

/**
 * Action-oriented guidance keyed by operation name. Every canonical operation
 * has an entry so the MCP surface never falls back to bare documentation text.
 */
export const MCP_TOOL_GUIDANCE: Record<OperationName, McpToolGuidance> = {
  create_job_requisition: {
    summary:
      'Recruiter tool. Open a new role by providing a title, department, a list of requirements, and a compensation band (min, max, currency). Returns the new jobId, which other tools use to reference the role.',
    confirmation: 'confirm'
  },
  list_open_jobs: {
    summary:
      'Read-only discovery tool. List the currently open jobs and return each exact jobId, title, department, requirements, and compensation band. Call this before answer_candidate_faq or other job-specific tools when the jobId is not already known.',
    confirmation: 'none'
  },
  search_candidates: {
    summary:
      'Recruiter or hiring-manager tool. Find and rank existing PipelineOS candidates by free-text query, skills, and experience level. Use this before screening or comparing. Returns up to ten ranked candidates with a match score and a plain-language rationale.',
    confirmation: 'none'
  },
  search_public_candidates: {
    summary:
      'Recruiter tool. Search allowlisted public GitHub profiles for potential prospects. This is discovery only: it does not create any candidate record and copies no private contact data. To bring a prospect into PipelineOS you must obtain consent and use import_public_prospect.',
    confirmation: 'none'
  },
  get_candidate_profile: {
    summary:
      'Read a single candidate: skills, resume text, and full application history across jobs. Use it to answer questions about one person or to gather context before screening, comparing, or making an offer.',
    confirmation: 'none'
  },
  submit_application: {
    summary:
      'Candidate tool. Apply one candidate to one open job with resume text. One application per candidate/job pair. Returns the applicationId with status "applied". Confirm the target job with the candidate first.',
    confirmation: 'confirm'
  },
  screen_candidate: {
    summary:
      'Recruiter tool. Compute and save an explainable screening score for an application by matching candidate skills against the job requirements. Moves the application from "applied" to "screened". The score and rationale are deterministic and auditable.',
    confirmation: 'confirm'
  },
  answer_candidate_faq: {
    summary:
      'Candidate-facing tool. Answer a question about a role using only that requisition\'s data (title, department, requirements, compensation band). If the data cannot answer it, the result says so rather than guessing. Safe to call on behalf of a candidate researching a job.',
    confirmation: 'none'
  },
  check_interviewer_availability: {
    summary:
      'Recruiter tool. Find interview slots that every interviewer on a panel is free for, within a start/end date range. Read-only. Use it before proposing slots.',
    confirmation: 'none'
  },
  propose_interview_slots: {
    summary:
      'Recruiter tool. Propose up to three common interview slots for an application so the candidate can pick one. Creates "proposed" interview records. Prefer coordinate_interview_workflow when you want proposal and booking managed together with human approval.',
    confirmation: 'confirm'
  },
  book_interview: {
    summary:
      'Candidate or recruiter tool. Confirm one of the proposed interview slots. Books that slot, cancels the sibling proposals, and moves the application to "interviewing". Confirm the chosen time with the candidate first.',
    confirmation: 'confirm'
  },
  get_interview_kit: {
    summary:
      'Interviewer or hiring-manager tool. Get the role-specific interview kit: competencies and suggested questions. Read-only. Use it to prepare before an interview.',
    confirmation: 'none'
  },
  submit_interview_feedback: {
    summary:
      'Interviewer or hiring-manager tool. Submit a structured scorecard for a booked interview: 1-5 competency scores, a recommendation (strong_yes, yes, no, strong_no), and comments. Marks the interview completed.',
    confirmation: 'confirm'
  },
  get_panel_feedback_summary: {
    summary:
      'Recruiter or hiring-manager tool. Summarize all scorecards for an application: average competency scores and a recommendation tally. Read-only. Review this before deciding on an offer.',
    confirmation: 'none'
  },
  generate_offer: {
    summary:
      'Recruiter tool. Create a DRAFT offer for an application at a given compensation amount. This does not send anything and does not move the application. It warns (without blocking) if the amount is outside the job band. Follow with send_offer once reviewed.',
    confirmation: 'confirm'
  },
  send_offer: {
    summary:
      'Recruiter tool. Send an existing draft offer to the candidate. This is consequential and visible to the candidate. Always confirm the offer details with the recruiter before sending; do not send an offer on your own initiative.',
    confirmation: 'confirm'
  },
  respond_to_offer: {
    summary:
      'Candidate tool. Respond to a sent offer: accept, decline, or counter with an amount. Confirm the decision with the candidate before calling it, since accept and decline are final.',
    confirmation: 'confirm'
  },
  initiate_background_check: {
    summary:
      'Recruiter tool. Start the background check for an accepted offer. In this deterministic build it resolves to "clear". Only valid after the offer is accepted.',
    confirmation: 'confirm'
  },
  enroll_benefits: {
    summary:
      'Candidate tool. Enroll an accepted offer in medical, dental, and vision plans chosen from the plan catalog. Confirm the selections with the candidate first.',
    confirmation: 'confirm'
  },
  generate_onboarding_checklist: {
    summary:
      'Recruiter tool. Generate the role-specific onboarding checklist for an accepted offer and move the application to "onboarding". Prefer coordinate_onboarding_workflow when you also want to advance individual tasks.',
    confirmation: 'confirm'
  },
  get_onboarding_status: {
    summary:
      'Recruiter, new-hire, or delegated-agent tool. Get consolidated onboarding progress: background-check status, benefits enrollment, and task completion. Read-only.',
    confirmation: 'none'
  },
  plan_operation: {
    summary:
      'The human-in-the-loop entry point. Simulate a sensitive operation (import_public_prospect, coordinate_interview_workflow, or coordinate_onboarding_workflow) WITHOUT changing any records, and create a reviewable approval card. Returns an approvalId plus a change summary, warnings, and blockers to show the human. This is how a sensitive action gets queued for approval instead of being applied directly.',
    confirmation: 'none'
  },
  get_approval_card: {
    summary:
      'Read a pending approval card by approvalId: its change summary, warnings, blockers, and expiry. Read-only. Show this to the human so they can decide whether to approve.',
    confirmation: 'none'
  },
  approve_operation_plan: {
    summary:
      'Human-only tool. Mark a pending approval card as approved. It does NOT apply the change yet. Only a recruiter/approver identity can call this; an agent identity cannot approve on the human\'s behalf. After approval, call commit_operation_plan to apply it.',
    confirmation: 'none'
  },
  reject_operation_plan: {
    summary:
      'Human-only tool. Reject a pending approval card so it can never be committed. Only a recruiter/approver identity can call this. Use it when the human declines the proposed change.',
    confirmation: 'none'
  },
  commit_operation_plan: {
    summary:
      'Apply an approved, unexpired approval card atomically. This is the step that actually performs the sensitive change after a human approved it. Fails if the plan was not approved, has expired, or the underlying state changed.',
    confirmation: 'none'
  },
  compare_candidates: {
    summary:
      'Recruiter or hiring-manager tool. Compare two to five candidates against one job with explainable, deterministic scoring across requirements, skills, and experience. Read-only. Use it to support a shortlist decision.',
    confirmation: 'none'
  },
  get_recruiting_workflow_status: {
    summary:
      'Get a role-scoped snapshot of the recruiting pipeline: application counts by stage, blockers, suggested next actions, and any pending approvals. Read-only. A good first call to orient before acting.',
    confirmation: 'none'
  },
  import_public_prospect: {
    summary:
      'Recruiter tool. Bring an allowlisted public prospect into PipelineOS as a candidate. Requires explicit consent metadata AND human approval, and records immutable provenance. Do not call this directly; stage it with plan_operation and complete the approval workflow.',
    confirmation: 'consent_and_plan'
  },
  revoke_public_prospect_consent: {
    summary:
      'Recruiter tool. Withdraw consent for a previously imported public prospect and apply the retention action. This is terminal: the prospect cannot be reused without fresh consent. Requires human approval.',
    confirmation: 'plan'
  },
  coordinate_interview_workflow: {
    summary:
      'Recruiter tool. Run interview scheduling as one coordinated, approvable step: either propose slots or book a chosen slot for an application. Requires human approval; stage it with plan_operation and complete the approve/commit workflow.',
    confirmation: 'plan'
  },
  coordinate_onboarding_workflow: {
    summary:
      'Recruiter tool. Run onboarding as one coordinated, approvable step: initialize the checklist for an accepted offer or advance a task (pending -> in_progress -> complete). Requires human approval; stage it with plan_operation and complete the approve/commit workflow.',
    confirmation: 'plan'
  },
  discover_capabilities: {
    summary:
      'Return the capability manifest for the current identity: which operations are allowed, their execution mode, and approval requirements. Read-only and informational. Useful to decide what you can do before attempting an action.',
    confirmation: 'none'
  }
};
