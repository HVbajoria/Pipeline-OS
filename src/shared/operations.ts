/**
 * Canonical operation contracts shared by the server, UI client, and WebMCP
 * adapters.  This module is intentionally free of runtime/framework
 * dependencies so the same schemas can be used at every boundary.
 */

import type {
  ActivityLogEntry,
  ActivityPhase,
  ActorContext,
  ApprovalCard,
  ApprovalCardPolicy,
  ApprovalCardRecord,
  ApprovalCardStatus,
  ApprovalCardSummary,
  ApprovalId,
  ApprovalPolicy,
  ApprovalRecordEffect,
  ApplicationRecord,
  BackgroundCheckStatus,
  CandidateRecord,
  CapabilityDescriptor,
  CapabilityManifest,
  CompensationBand,
  CorrelationId,
  DateRange,
  ExperienceLevel,
  GeneratedIdPlaceholder,
  InterviewRecommendation,
  InvocationMetadata,
  JobRequisition,
  JsonObject,
  OfferDecision,
  OfferResponseStatus,
  OperationExecutionClass,
  PlanSelections,
  ScorecardRecord,
  ScorecardRecommendation,
  SourcedProspectId,
  SpanId,
  StartDate,
  TaskCompletion,
  Timestamp,
  TraceId,
  TraceSpan,
  TraceSpanStatus
} from './models';
import type {
  CandidateSubmittedProfile,
  GitHubProspect,
  GitHubProspectAttribution,
  GitHubProspectCacheMetadata,
  GitHubProspectSearchInput,
  GitHubProspectSearchResult,
  NormalizedGitHubProspectSearchInput,
  PublicProspectConsent,
  PublicProspectFieldOrigin,
  PublicProspectSourceReference,
  SourcedProspectRecord
} from './publicProspects';
import {
  GITHUB_PROSPECT_DATA_ORIGIN,
  GITHUB_PROSPECT_FILTER_MAX_LENGTH,
  GITHUB_PROSPECT_QUERY_MAX_LENGTH,
  GITHUB_PROSPECT_SAFE_TEXT_PATTERN,
  GITHUB_PROSPECT_SOURCE,
  PUBLIC_PROSPECT_CONSENT_METHODS,
  PUBLIC_PROSPECT_CONSENT_STATUSES,
  PUBLIC_PROSPECT_CANDIDATE_LINK_ORIGINS,
  PUBLIC_PROSPECT_EVIDENCE_REFERENCE_MAX_LENGTH,
  PUBLIC_PROSPECT_FIELD_ORIGINS,
  PUBLIC_PROSPECT_POLICY_VERSION_MAX_LENGTH,
  PUBLIC_PROSPECT_SCOPE_MAX_LENGTH,
  PUBLIC_PROSPECT_SOURCE_RECORD_MAX_LENGTH,
  PUBLIC_PROSPECT_URL_MAX_LENGTH
} from './publicProspects';
import {
  APPROVAL_CARD_POLICIES,
  APPROVAL_CARD_STATUSES,
  APPROVAL_POLICIES,
  APPROVAL_RECORD_EFFECTS,
  ACTOR_TYPES,
  BACKGROUND_CHECK_STATUSES,
  CAPABILITY_DENIAL_REASONS,
  EXPERIENCE_LEVELS,
  ONBOARDING_TASK_STATUSES,
  OPERATION_EXECUTION_CLASSES,
  OFFER_DECISIONS,
  OFFER_RESPONSE_STATUSES,
  SCORECARD_RECOMMENDATIONS,
  TRACE_SPAN_STATUSES
} from './models';

/** A JSON Schema type supported by the shared validator. */
export type JsonSchemaType =
  | 'array'
  | 'boolean'
  | 'integer'
  | 'null'
  | 'number'
  | 'object'
  | 'string';

/**
 * The subset of JSON Schema needed by PipelineOS operation contracts.  The
 * shape deliberately remains JSON-serializable so it can be handed directly
 * to a WebMCP runtime.
 */
export interface JsonSchema {
  $schema?: string;
  title?: string;
  description?: string;
  type?: JsonSchemaType | readonly JsonSchemaType[];
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: readonly unknown[];
  const?: unknown;
  oneOf?: readonly JsonSchema[];
  anyOf?: readonly JsonSchema[];
  allOf?: readonly JsonSchema[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
}

/** Common spelling used by WebMCP/JSON Schema integrations. */
export type JSONSchema = JsonSchema;

/** The exact set of operations exposed by PipelineOS. */
export const OPERATION_NAMES = [
  'create_job_requisition',
  'list_open_jobs',
  'search_candidates',
  'search_public_candidates',
  'get_candidate_profile',
  'submit_application',
  'screen_candidate',
  'answer_candidate_faq',
  'check_interviewer_availability',
  'propose_interview_slots',
  'book_interview',
  'get_interview_kit',
  'submit_interview_feedback',
  'get_panel_feedback_summary',
  'generate_offer',
  'send_offer',
  'respond_to_offer',
  'initiate_background_check',
  'enroll_benefits',
  'generate_onboarding_checklist',
  'get_onboarding_status',
  'plan_operation',
  'get_approval_card',
  'approve_operation_plan',
  'reject_operation_plan',
  'commit_operation_plan',
  'compare_candidates',
  'get_recruiting_workflow_status',
  'import_public_prospect',
  'revoke_public_prospect_consent',
  'coordinate_interview_workflow',
  'coordinate_onboarding_workflow',
  'discover_capabilities'
] as const;

export type OperationName = (typeof OPERATION_NAMES)[number];

/** Operations that may be selected as a target by plan_operation. */
export const PLANABLE_OPERATION_NAMES = [
  'import_public_prospect',
  'coordinate_interview_workflow',
  'coordinate_onboarding_workflow'
] as const;
export type PlanableOperationName = (typeof PLANABLE_OPERATION_NAMES)[number];

/** Stable implementation keys used by the server operation dispatcher. */
export const OPERATION_IMPLEMENTATION_KEYS = {
  create_job_requisition: 'createJobRequisition',
  list_open_jobs: 'listOpenJobs',
  search_candidates: 'searchCandidates',
  search_public_candidates: 'searchPublicCandidates',
  get_candidate_profile: 'getCandidateProfile',
  submit_application: 'submitApplication',
  screen_candidate: 'screenCandidate',
  answer_candidate_faq: 'answerCandidateFaq',
  check_interviewer_availability: 'checkInterviewerAvailability',
  propose_interview_slots: 'proposeInterviewSlots',
  book_interview: 'bookInterview',
  get_interview_kit: 'getInterviewKit',
  submit_interview_feedback: 'submitInterviewFeedback',
  get_panel_feedback_summary: 'getPanelFeedbackSummary',
  generate_offer: 'generateOffer',
  send_offer: 'sendOffer',
  respond_to_offer: 'respondToOffer',
  initiate_background_check: 'initiateBackgroundCheck',
  enroll_benefits: 'enrollBenefits',
  generate_onboarding_checklist: 'generateOnboardingChecklist',
  get_onboarding_status: 'getOnboardingStatus',
  plan_operation: 'planOperation',
  get_approval_card: 'getApprovalCard',
  approve_operation_plan: 'approveOperationPlan',
  reject_operation_plan: 'rejectOperationPlan',
  commit_operation_plan: 'commitOperationPlan',
  compare_candidates: 'compareCandidates',
  get_recruiting_workflow_status: 'getRecruitingWorkflowStatus',
  import_public_prospect: 'importPublicProspect',
  revoke_public_prospect_consent: 'revokePublicProspectConsent',
  coordinate_interview_workflow: 'coordinateInterviewWorkflow',
  coordinate_onboarding_workflow: 'coordinateOnboardingWorkflow',
  discover_capabilities: 'discoverCapabilities'
} as const satisfies { readonly [N in OperationName]: string };

export type OperationImplementationKey =
  (typeof OPERATION_IMPLEMENTATION_KEYS)[OperationName];

// ---------------------------------------------------------------------------
// Operation input and output contracts
// ---------------------------------------------------------------------------

export interface CreateJobRequisitionInput {
  title: string;
  department: string;
  requirements: string[];
  compBand: CompensationBand;
}

export interface CreateJobRequisitionOutput {
  jobId: string;
}

export type ListOpenJobsInput = Record<string, never>;

export interface OpenJobSummary {
  jobId: string;
  title: string;
  department: string;
  requirements: string[];
  compBand: CompensationBand;
}

export interface ListOpenJobsOutput {
  jobs: OpenJobSummary[];
}

export interface SearchCandidatesInput {
  query?: string;
  skills?: string[];
  experienceLevel?: ExperienceLevel;
}

export interface CandidateSearchResult {
  candidateId: string;
  name: string;
  matchScore: number;
  rationale: string;
}

export interface SearchCandidatesOutput {
  results: CandidateSearchResult[];
}

export type SearchPublicCandidatesInput = GitHubProspectSearchInput;
export type SearchPublicCandidatesOutput = GitHubProspectSearchResult;

export interface GetCandidateProfileInput {
  candidateId: string;
}

export type GetCandidateProfileOutput = CandidateRecord & {
  applicationHistory: ApplicationRecord[];
};

export interface SubmitApplicationInput {
  candidateId: string;
  jobId: string;
  resumeText: string;
}

export interface SubmitApplicationOutput {
  applicationId: string;
  status: 'applied';
}

export interface ScreenCandidateInput {
  applicationId: string;
}

export interface ScreenCandidateOutput {
  applicationId: string;
  screeningScore: number;
  screeningRationale: string;
  status: 'screened';
}

export interface AnswerCandidateFaqInput {
  jobId: string;
  question: string;
}

export interface AnswerCandidateFaqOutput {
  answer: string;
  answeredFromData: boolean;
}

export interface CheckInterviewerAvailabilityInput {
  panelId: string;
  dateRange: DateRange;
}

export interface CheckInterviewerAvailabilityOutput {
  commonFreeSlots: Timestamp[];
}

export interface ProposeInterviewSlotsInput {
  applicationId: string;
}

export interface ProposedInterviewSlot {
  interviewId: string;
  slot: Timestamp;
}

export interface ProposeInterviewSlotsOutput {
  proposedSlots: ProposedInterviewSlot[];
}

export interface BookInterviewInput {
  applicationId: string;
  slot: Timestamp;
}

export interface BookInterviewOutput {
  interviewId: string;
  status: 'booked';
}

export interface GetInterviewKitInput {
  jobId: string;
}

export interface InterviewKitCompetency {
  name: string;
  questions: string[];
}

export interface GetInterviewKitOutput {
  competencies: InterviewKitCompetency[];
}

export interface SubmitInterviewFeedbackInput {
  interviewId: string;
  interviewer: string;
  competencyScores: Record<string, number>;
  recommendation: InterviewRecommendation;
  comments: string;
}

export interface SubmitInterviewFeedbackOutput {
  scorecardId: string;
}

export interface GetPanelFeedbackSummaryInput {
  applicationId: string;
}

export type RecommendationTally = Partial<
  Record<ScorecardRecommendation, number>
>;

export interface GetPanelFeedbackSummaryOutput {
  averageScores: Record<string, number>;
  recommendationTally: RecommendationTally;
  scorecards: ScorecardRecord[];
}

export interface GenerateOfferInput {
  applicationId: string;
  compAmount: number;
}

export interface GenerateOfferOutput {
  offerId: string;
  status: 'draft';
}

export interface SendOfferInput {
  offerId: string;
}

export interface SendOfferOutput {
  offerId: string;
  status: 'sent';
}

export type RespondToOfferInput =
  | {
      offerId: string;
      decision: Extract<OfferDecision, 'accept' | 'decline'>;
      counterAmount?: number;
    }
  | {
      offerId: string;
      decision: Extract<OfferDecision, 'counter'>;
      counterAmount: number;
    };

export interface RespondToOfferOutput {
  offerId: string;
  status: OfferResponseStatus;
}

export interface InitiateBackgroundCheckInput {
  offerId: string;
}

/** Background checks are returned before/after the deterministic clear step. */
export interface InitiateBackgroundCheckOutput {
  backgroundCheckId: string;
  status: Extract<BackgroundCheckStatus, 'pending' | 'clear'>;
}

export interface EnrollBenefitsInput {
  offerId: string;
  planSelections: PlanSelections;
}

export interface EnrollBenefitsOutput {
  enrollmentId: string;
}

export interface GenerateOnboardingChecklistInput {
  offerId: string;
}

export interface OnboardingTaskSummary {
  taskId: string;
  taskName: string;
  dueDate: Timestamp;
  /** Coordinator responses include the authoritative changed status; legacy checklist responses omit it. */
  status?: 'pending' | 'in_progress' | 'complete';
}

export interface GenerateOnboardingChecklistOutput {
  tasks: OnboardingTaskSummary[];
}

export interface GetOnboardingStatusInput {
  offerId: string;
}

export interface GetOnboardingStatusOutput {
  backgroundCheckStatus: BackgroundCheckStatus | null;
  benefitsEnrolled: boolean;
  taskCompletion: TaskCompletion;
  completionPercentage: number;
}

// ---------------------------------------------------------------------------
// Approval, provenance, comparison, workflow, and capability contracts
// ---------------------------------------------------------------------------

export interface PlanOperationInput {
  targetOperation: PlanableOperationName;
  /** Target input remains nested and is never merged into invocation metadata. */
  input: JsonObject;
}

export interface PlanOperationOutput {
  approvalId: ApprovalId;
  targetOperation: PlanableOperationName;
  proposedOutput: JsonObject;
  changeSummary: string[];
  warnings: string[];
  blockers: string[];
  baseRevision: number;
  expiresAt: Timestamp;
  requiredApproval: ApprovalCardPolicy;
  requiredCapability: string;
  status: 'pending';
  /** Policy version captured with the approval card, when available. */
  policyVersion?: string;
  redactions: string[];
}

export interface GetApprovalCardInput {
  approvalId: ApprovalId;
}
export type GetApprovalCardOutput = ApprovalCardSummary;

export interface ApproveOperationPlanInput {
  approvalId: ApprovalId;
  note?: string;
}

export interface ApproveOperationPlanOutput {
  approvalId: ApprovalId;
  status: 'approved';
  approvedBy: ActorContext;
  approvedAt: Timestamp;
  note?: string;
  policyVersion?: string;
}

export interface RejectOperationPlanInput {
  approvalId: ApprovalId;
  note?: string;
}

export interface RejectOperationPlanOutput {
  approvalId: ApprovalId;
  status: 'rejected';
  rejectedBy: ActorContext;
  rejectedAt: Timestamp;
  note?: string;
  policyVersion?: string;
}

export interface CommitOperationPlanInput {
  approvalId: ApprovalId;
}

export interface CommitOperationPlanOutput {
  approvalId: ApprovalId;
  targetOperation: OperationName;
  status: 'committed';
  output: JsonObject;
  committedAt: Timestamp;
  redactions?: string[];
}

export interface CompareCandidatesInput {
  jobId: string;
  candidateIds: string[];
}

export interface CandidateComparisonRequirementMatch {
  matched: string[];
  missing: string[];
  score: number;
}

export interface CandidateComparisonSkillOverlap {
  matched: string[];
  score: number;
}

export interface CandidateComparisonExperienceFit {
  evidence: string;
  score: number;
}

export interface CandidateComparisonScoreBreakdown {
  requirementMatch: CandidateComparisonRequirementMatch;
  skillOverlap: CandidateComparisonSkillOverlap;
  experienceFit: CandidateComparisonExperienceFit;
}

export interface CandidateComparison {
  candidateId: string;
  name: string;
  rank: number;
  totalScore: number;
  scoreBreakdown: CandidateComparisonScoreBreakdown;
  rationale: string;
  limitations: string[];
}

export interface CompareCandidatesOutput {
  jobId: string;
  revision: number;
  candidates: CandidateComparison[];
}

export type WorkflowStatusDetail = 'summary' | 'full';

export interface GetRecruitingWorkflowStatusInput {
  jobId?: string;
  applicationId?: string;
  candidateId?: string;
  detail?: WorkflowStatusDetail;
  limit?: number;
}

export interface WorkflowApplicationSummary {
  applicationId: string;
  candidateId: string;
  jobId: string;
  status: string;
  currentStage: string;
  blockers: string[];
  nextActions: string[];
}

export interface RecruitingWorkflowScope {
  jobId?: string;
  applicationId?: string;
  candidateId?: string;
}

export interface GetRecruitingWorkflowStatusOutput {
  revision: number;
  scope: RecruitingWorkflowScope;
  countsByApplicationStatus: Record<string, number>;
  applications: WorkflowApplicationSummary[];
  pendingApprovals: ApprovalCardSummary[];
  blockers: string[];
  nextActions: string[];
  generatedAt: Timestamp;
}

export interface ImportPublicProspectInput extends PublicProspectSourceReference {
  consent: PublicProspectConsent;
  candidateProfile?: CandidateSubmittedProfile;
}

export interface ImportPublicProspectOutput {
  sourcedProspect: SourcedProspectRecord;
  candidateId?: string;
  status: 'imported' | 'linked';
}

export interface RevokePublicProspectConsentInput {
  sourcedProspectId: SourcedProspectId;
  reason?: string;
}

export interface RevokePublicProspectConsentOutput {
  sourcedProspectId: SourcedProspectId;
  status: 'withdrawn';
  withdrawnAt: Timestamp;
  retentionAction: string;
}

export type CoordinateInterviewAction = 'propose_slots' | 'book_slot';

export interface CoordinateInterviewWorkflowInput {
  applicationId: string;
  action: CoordinateInterviewAction;
  slot?: Timestamp;
}

export interface CoordinatedBookedInterview {
  interviewId: string;
  slot: Timestamp;
}

export interface CoordinateInterviewWorkflowOutput {
  applicationId: string;
  stage: string;
  proposedSlots: ProposedInterviewSlot[];
  bookedInterview: CoordinatedBookedInterview | null;
  nextAction: string | null;
  blockers: string[];
}

export type CoordinateOnboardingAction =
  | 'initialize_checklist'
  | 'update_task';

export interface CoordinateOnboardingWorkflowInput {
  offerId: string;
  action: CoordinateOnboardingAction;
  taskId?: string;
  status?: 'pending' | 'in_progress' | 'complete';
}

export interface CoordinateOnboardingWorkflowOutput {
  offerId: string;
  changedTasks: OnboardingTaskSummary[];
  backgroundCheckStatus: BackgroundCheckStatus | null;
  benefitsEnrolled: boolean;
  taskCompletion: TaskCompletion;
  completionPercentage: number;
  blockers: string[];
  nextActions: string[];
}

export type DiscoverCapabilitiesInput = Record<string, never>;
export type DiscoverCapabilitiesOutput = CapabilityManifest;

/** Input types indexed by the canonical operation name. */
export interface OperationInputMap {
  create_job_requisition: CreateJobRequisitionInput;
  list_open_jobs: ListOpenJobsInput;
  search_candidates: SearchCandidatesInput;
  search_public_candidates: SearchPublicCandidatesInput;
  get_candidate_profile: GetCandidateProfileInput;
  submit_application: SubmitApplicationInput;
  screen_candidate: ScreenCandidateInput;
  answer_candidate_faq: AnswerCandidateFaqInput;
  check_interviewer_availability: CheckInterviewerAvailabilityInput;
  propose_interview_slots: ProposeInterviewSlotsInput;
  book_interview: BookInterviewInput;
  get_interview_kit: GetInterviewKitInput;
  submit_interview_feedback: SubmitInterviewFeedbackInput;
  get_panel_feedback_summary: GetPanelFeedbackSummaryInput;
  generate_offer: GenerateOfferInput;
  send_offer: SendOfferInput;
  respond_to_offer: RespondToOfferInput;
  initiate_background_check: InitiateBackgroundCheckInput;
  enroll_benefits: EnrollBenefitsInput;
  generate_onboarding_checklist: GenerateOnboardingChecklistInput;
  get_onboarding_status: GetOnboardingStatusInput;
  plan_operation: PlanOperationInput;
  get_approval_card: GetApprovalCardInput;
  approve_operation_plan: ApproveOperationPlanInput;
  reject_operation_plan: RejectOperationPlanInput;
  commit_operation_plan: CommitOperationPlanInput;
  compare_candidates: CompareCandidatesInput;
  get_recruiting_workflow_status: GetRecruitingWorkflowStatusInput;
  import_public_prospect: ImportPublicProspectInput;
  revoke_public_prospect_consent: RevokePublicProspectConsentInput;
  coordinate_interview_workflow: CoordinateInterviewWorkflowInput;
  coordinate_onboarding_workflow: CoordinateOnboardingWorkflowInput;
  discover_capabilities: DiscoverCapabilitiesInput;
}

/** Output types indexed by the canonical operation name. */
export interface OperationOutputMap {
  create_job_requisition: CreateJobRequisitionOutput;
  list_open_jobs: ListOpenJobsOutput;
  search_candidates: SearchCandidatesOutput;
  search_public_candidates: SearchPublicCandidatesOutput;
  get_candidate_profile: GetCandidateProfileOutput;
  submit_application: SubmitApplicationOutput;
  screen_candidate: ScreenCandidateOutput;
  answer_candidate_faq: AnswerCandidateFaqOutput;
  check_interviewer_availability: CheckInterviewerAvailabilityOutput;
  propose_interview_slots: ProposeInterviewSlotsOutput;
  book_interview: BookInterviewOutput;
  get_interview_kit: GetInterviewKitOutput;
  submit_interview_feedback: SubmitInterviewFeedbackOutput;
  get_panel_feedback_summary: GetPanelFeedbackSummaryOutput;
  generate_offer: GenerateOfferOutput;
  send_offer: SendOfferOutput;
  respond_to_offer: RespondToOfferOutput;
  initiate_background_check: InitiateBackgroundCheckOutput;
  enroll_benefits: EnrollBenefitsOutput;
  generate_onboarding_checklist: GenerateOnboardingChecklistOutput;
  get_onboarding_status: GetOnboardingStatusOutput;
  plan_operation: PlanOperationOutput;
  get_approval_card: GetApprovalCardOutput;
  approve_operation_plan: ApproveOperationPlanOutput;
  reject_operation_plan: RejectOperationPlanOutput;
  commit_operation_plan: CommitOperationPlanOutput;
  compare_candidates: CompareCandidatesOutput;
  get_recruiting_workflow_status: GetRecruitingWorkflowStatusOutput;
  import_public_prospect: ImportPublicProspectOutput;
  revoke_public_prospect_consent: RevokePublicProspectConsentOutput;
  coordinate_interview_workflow: CoordinateInterviewWorkflowOutput;
  coordinate_onboarding_workflow: CoordinateOnboardingWorkflowOutput;
  discover_capabilities: DiscoverCapabilitiesOutput;
}

/** Additive WebMCP annotations derived from the canonical operation descriptor. */
export interface OperationAnnotations {
  readOnlyHint: boolean;
  executionClass: OperationExecutionClass;
  requiresApproval: boolean;
  planable: boolean;
}

/** A WebMCP-compatible descriptor for one shared operation. */
export interface OperationDescriptor<N extends OperationName = OperationName> {
  name: N;
  description: string;
  /** Server-side annotation used by clients and documentation. */
  readOnly: boolean;
  /** WebMCP annotation name used by native runtimes. */
  readOnlyHint: boolean;
  annotations: OperationAnnotations;
  executionClass: OperationExecutionClass;
  directlyCallable: boolean;
  planable: boolean;
  approvalPolicy: ApprovalPolicy;
  /**
   * Whether an autonomous `agent` principal (for example an LLM host such as a
   * ChatGPT connector) may execute this operation directly. `'forbidden'`
   * means the mutation is irreversible enough that an agent must instead go
   * through the human-in-the-loop plan → approve → commit lifecycle; human
   * principals are unaffected. Defaults to `'allowed'`.
   */
  agentDirectExecution: 'allowed' | 'forbidden';
  requiredCapability: string;
  implementationKey: OperationImplementationKey;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

export type OperationRegistry = {
  readonly [N in OperationName]: OperationDescriptor<N>;
};

// ---------------------------------------------------------------------------
// Shared JSON Schema descriptors
// ---------------------------------------------------------------------------

const idSchema: JsonSchema = {
  type: 'string',
  minLength: 1
};

const requiredStringSchema: JsonSchema = {
  type: 'string',
  minLength: 1
};

const timestampSchema: JsonSchema = {
  type: 'string',
  minLength: 1,
  format: 'date-time'
};

const compensationBandSchema: JsonSchema = {
  type: 'object',
  properties: {
    min: { type: 'number' },
    max: { type: 'number' },
    currency: requiredStringSchema
  },
  required: ['min', 'max', 'currency'],
  additionalProperties: false
};

const dateRangeSchema: JsonSchema = {
  type: 'object',
  properties: {
    start: timestampSchema,
    end: timestampSchema
  },
  required: ['start', 'end'],
  additionalProperties: false
};

const candidateRecordSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: idSchema,
    name: requiredStringSchema,
    email: requiredStringSchema,
    resumeText: requiredStringSchema,
    skills: {
      type: 'array',
      items: requiredStringSchema
    },
    experienceYears: {
      type: 'number',
      minimum: 0
    },
    resumeTextHistory: {
      type: 'array',
      items: requiredStringSchema
    }
  },
  required: [
    'id',
    'name',
    'email',
    'resumeText',
    'skills',
    'experienceYears',
    'resumeTextHistory'
  ],
  additionalProperties: false
};

const publicProspectTextSchema: JsonSchema = {
  type: 'string',
  pattern: GITHUB_PROSPECT_SAFE_TEXT_PATTERN
};

const publicProspectInputTextSchema: JsonSchema = {
  ...publicProspectTextSchema,
  maxLength: GITHUB_PROSPECT_FILTER_MAX_LENGTH
};

const publicProspectQuerySchema: JsonSchema = {
  ...publicProspectInputTextSchema,
  minLength: 1,
  maxLength: GITHUB_PROSPECT_QUERY_MAX_LENGTH
};

const normalizedPublicProspectFiltersSchema: JsonSchema = {
  type: 'object',
  properties: {
    query: publicProspectQuerySchema,
    language: publicProspectInputTextSchema,
    location: publicProspectInputTextSchema
  },
  required: ['query'],
  additionalProperties: false
};

const publicProspectSchema: JsonSchema = {
  type: 'object',
  properties: {
    source: { type: 'string', const: GITHUB_PROSPECT_SOURCE },
    sourceUrl: { type: 'string', minLength: 1 },
    profileUrl: { type: 'string', minLength: 1 },
    username: requiredStringSchema,
    login: requiredStringSchema,
    avatarUrl: { type: 'string', minLength: 1 },
    profileType: requiredStringSchema,
    searchScore: { type: 'number' },
    query: publicProspectTextSchema,
    fetchedAt: timestampSchema,
    dataOrigin: { type: 'string', const: GITHUB_PROSPECT_DATA_ORIGIN },
    consentStatus: { type: 'string', const: 'not_provided' },
    location: publicProspectTextSchema,
    bio: publicProspectTextSchema,
    publicRepos: { type: 'integer', minimum: 0 }
  },
  required: [
    'source',
    'sourceUrl',
    'profileUrl',
    'username',
    'login',
    'profileType',
    'searchScore',
    'query',
    'fetchedAt',
    'dataOrigin',
    'consentStatus'
  ],
  additionalProperties: false
};

const publicProspectCacheSchema: JsonSchema = {
  type: 'object',
  properties: {
    hit: { type: 'boolean' },
    coalesced: { type: 'boolean' },
    ageMs: { type: 'number', minimum: 0 },
    ttlMs: { type: 'number', minimum: 0 },
    fetchedAt: timestampSchema,
    expiresAt: timestampSchema
  },
  required: ['hit', 'coalesced', 'ageMs', 'ttlMs', 'fetchedAt', 'expiresAt'],
  additionalProperties: false
};

const publicProspectAttributionSchema: JsonSchema = {
  type: 'object',
  properties: {
    source: { type: 'string', const: GITHUB_PROSPECT_SOURCE },
    apiUrl: { type: 'string', minLength: 1 },
    searchApiDocsUrl: { type: 'string', minLength: 1 },
    rateLimitsDocsUrl: { type: 'string', minLength: 1 },
    userApiDocsUrl: { type: 'string', minLength: 1 }
  },
  required: [
    'source',
    'apiUrl',
    'searchApiDocsUrl',
    'rateLimitsDocsUrl',
    'userApiDocsUrl'
  ],
  additionalProperties: false
};

const publicProspectSearchResultSchema: JsonSchema = {
  type: 'object',
  properties: {
    prospects: {
      type: 'array',
      items: publicProspectSchema
    },
    query: publicProspectTextSchema,
    filters: normalizedPublicProspectFiltersSchema,
    source: { type: 'string', const: GITHUB_PROSPECT_SOURCE },
    fetchedAt: timestampSchema,
    cache: publicProspectCacheSchema,
    attribution: publicProspectAttributionSchema
  },
  required: [
    'prospects',
    'query',
    'filters',
    'source',
    'fetchedAt',
    'cache',
    'attribution'
  ],
  additionalProperties: false
};

const applicationRecordSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: idSchema,
    candidateId: idSchema,
    jobId: idSchema,
    status: {
      type: 'string',
      enum: [
        'applied',
        'screened',
        'interviewing',
        'offer_sent',
        'offer_accepted',
        'offer_declined',
        'rejected',
        'onboarding'
      ]
    },
    screeningScore: { type: ['number', 'null'] as const },
    screeningRationale: { type: ['string', 'null'] as const },
    notes: { type: 'array' },
    createdAt: timestampSchema
  },
  required: [
    'id',
    'candidateId',
    'jobId',
    'status',
    'screeningScore',
    'screeningRationale',
    'notes',
    'createdAt'
  ],
  additionalProperties: false
};

const scorecardRecordSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: idSchema,
    interviewId: idSchema,
    interviewer: requiredStringSchema,
    competencyScores: {
      type: 'object',
      additionalProperties: {
        type: 'number',
        minimum: 1,
        maximum: 5
      }
    },
    recommendation: {
      type: 'string',
      enum: SCORECARD_RECOMMENDATIONS
    },
    comments: requiredStringSchema,
    submittedAt: timestampSchema
  },
  required: [
    'id',
    'interviewId',
    'interviewer',
    'competencyScores',
    'recommendation',
    'comments',
    'submittedAt'
  ],
  additionalProperties: false
};

const competencySchema: JsonSchema = {
  type: 'object',
  properties: {
    name: requiredStringSchema,
    questions: {
      type: 'array',
      minItems: 1,
      items: requiredStringSchema
    }
  },
  required: ['name', 'questions'],
  additionalProperties: false
};

/** Bounded limits for additive invocation, approval, provenance, and workflow contracts. */
export const MAX_METADATA_ID_LENGTH = 128;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
export const MAX_METADATA_REVISION = Number.MAX_SAFE_INTEGER;
export const MAX_APPROVAL_RECORDS = 20;
export const MAX_APPROVAL_SUMMARY_ITEMS = 20;
export const MAX_APPROVAL_TEXT_LENGTH = 500;
export const MAX_COMPARISON_CANDIDATES = 5;
export const MAX_WORKFLOW_STATUS_ITEMS = 50;
export const MAX_WORKFLOW_TEXT_LENGTH = 300;
export const MAX_TRACE_SPANS = 50;
export const MAX_TRACE_SUMMARY_PROPERTIES = 20;
export const MAX_CAPABILITIES = 64;
export const MAX_PROVENANCE_FIELDS = 32;
export const MAX_PROSPECT_URL_LENGTH = PUBLIC_PROSPECT_URL_MAX_LENGTH;

export const OPERATION_CONTRACT_LIMITS = {
  metadataId: MAX_METADATA_ID_LENGTH,
  idempotencyKey: MAX_IDEMPOTENCY_KEY_LENGTH,
  approvalRecords: MAX_APPROVAL_RECORDS,
  approvalSummaryItems: MAX_APPROVAL_SUMMARY_ITEMS,
  comparisonCandidates: MAX_COMPARISON_CANDIDATES,
  workflowStatusItems: MAX_WORKFLOW_STATUS_ITEMS,
  traceSpans: MAX_TRACE_SPANS,
  capabilities: MAX_CAPABILITIES,
  provenanceFields: MAX_PROVENANCE_FIELDS
} as const;

const safeIdentifierSchema = (maxLength = MAX_METADATA_ID_LENGTH): JsonSchema => ({
  type: 'string',
  minLength: 1,
  maxLength,
  pattern: '^[^\\u0000-\\u001F\\u007F]+$'
});

const boundedTextSchema = (maxLength: number): JsonSchema => ({
  type: 'string',
  minLength: 1,
  maxLength,
  pattern: '^[^\\u0000-\\u001F\\u007F]*$'
});

const boundedTextArraySchema = (maxItems: number, maxLength: number): JsonSchema => ({
  type: 'array',
  maxItems,
  items: boundedTextSchema(maxLength)
});

const jsonObjectSchema: JsonSchema = {
  type: 'object',
  maxProperties: 32,
  additionalProperties: true
};

const actorContextSchema: JsonSchema = {
  type: 'object',
  properties: {
    actorType: { type: 'string', enum: ACTOR_TYPES },
    actorId: safeIdentifierSchema()
  },
  required: ['actorType', 'actorId'],
  additionalProperties: false
};

const invocationMetadataSchema: JsonSchema = {
  type: 'object',
  properties: {
    correlationId: safeIdentifierSchema(MAX_METADATA_ID_LENGTH),
    idempotencyKey: safeIdentifierSchema(MAX_IDEMPOTENCY_KEY_LENGTH),
    expectedRevision: {
      type: 'integer',
      minimum: 0,
      maximum: MAX_METADATA_REVISION
    },
    approvalId: safeIdentifierSchema(MAX_METADATA_ID_LENGTH),
    parentSpanId: safeIdentifierSchema(MAX_METADATA_ID_LENGTH)
  },
  additionalProperties: false,
  maxProperties: 5
};

/** Public schema used by transport/client validators; metadata is not input. */
export const INVOCATION_METADATA_SCHEMA = invocationMetadataSchema;
export const operationInvocationMetadataSchema = INVOCATION_METADATA_SCHEMA;

const affectedRecordSchema: JsonSchema = {
  type: 'object',
  properties: {
    type: boundedTextSchema(100),
    id: safeIdentifierSchema(),
    effect: { type: 'string', enum: APPROVAL_RECORD_EFFECTS }
  },
  required: ['type', 'id', 'effect'],
  additionalProperties: false
};

const approvalCardSummarySchema: JsonSchema = {
  type: 'object',
  properties: {
    id: safeIdentifierSchema(),
    targetOperation: boundedTextSchema(100),
    requestedBy: actorContextSchema,
    requestedAt: timestampSchema,
    baseRevision: { type: 'integer', minimum: 0 },
    affectedRecords: {
      type: 'array',
      maxItems: MAX_APPROVAL_RECORDS,
      items: affectedRecordSchema
    },
    proposedOutput: jsonObjectSchema,
    changeSummary: boundedTextArraySchema(
      MAX_APPROVAL_SUMMARY_ITEMS,
      MAX_APPROVAL_TEXT_LENGTH
    ),
    warnings: boundedTextArraySchema(
      MAX_APPROVAL_SUMMARY_ITEMS,
      MAX_APPROVAL_TEXT_LENGTH
    ),
    blockers: boundedTextArraySchema(
      MAX_APPROVAL_SUMMARY_ITEMS,
      MAX_WORKFLOW_TEXT_LENGTH
    ),
    requiredCapability: boundedTextSchema(160),
    approvalPolicy: { type: 'string', enum: APPROVAL_CARD_POLICIES },
    policyVersion: boundedTextSchema(160),
    status: { type: 'string', enum: APPROVAL_CARD_STATUSES },
    approvalNote: boundedTextSchema(MAX_APPROVAL_TEXT_LENGTH),
    rejectionNote: boundedTextSchema(MAX_APPROVAL_TEXT_LENGTH),
    approvedBy: actorContextSchema,
    approvedAt: timestampSchema,
    rejectedBy: actorContextSchema,
    rejectedAt: timestampSchema,
    expiresAt: timestampSchema,
    correlationId: safeIdentifierSchema(),
    traceId: safeIdentifierSchema(),
    committedAt: timestampSchema,
    redactions: boundedTextArraySchema(MAX_APPROVAL_SUMMARY_ITEMS, 160)
  },
  required: [
    'id',
    'targetOperation',
    'requestedBy',
    'requestedAt',
    'baseRevision',
    'affectedRecords',
    'proposedOutput',
    'changeSummary',
    'warnings',
    'requiredCapability',
    'approvalPolicy',
    'status',
    'expiresAt',
    'correlationId',
    'traceId'
  ],
  additionalProperties: false,
  maxProperties: 26
};

const sourceFiltersSchema: JsonSchema = {
  type: 'object',
  properties: {
    language: publicProspectInputTextSchema,
    location: publicProspectInputTextSchema
  },
  additionalProperties: false,
  maxProperties: 2
};

const publicProspectSourceReferenceSchema: JsonSchema = {
  type: 'object',
  properties: {
    source: { type: 'string', const: GITHUB_PROSPECT_SOURCE },
    sourceRecordId: boundedTextSchema(PUBLIC_PROSPECT_SOURCE_RECORD_MAX_LENGTH),
    profileUrl: boundedTextSchema(MAX_PROSPECT_URL_LENGTH),
    canonicalSourceUrl: boundedTextSchema(MAX_PROSPECT_URL_LENGTH),
    sourceQuery: publicProspectQuerySchema,
    sourceFilters: sourceFiltersSchema,
    fetchedAt: timestampSchema,
    attribution: publicProspectAttributionSchema
  },
  required: [
    'source',
    'sourceRecordId',
    'profileUrl',
    'canonicalSourceUrl',
    'sourceQuery',
    'fetchedAt',
    'attribution'
  ],
  additionalProperties: false,
  maxProperties: 8
};

const consentSchema: JsonSchema = {
  type: 'object',
  properties: {
    method: {
      type: 'string',
      enum: PUBLIC_PROSPECT_CONSENT_METHODS
    },
    scope: boundedTextSchema(PUBLIC_PROSPECT_SCOPE_MAX_LENGTH),
    capturedAt: timestampSchema,
    capturedBy: actorContextSchema,
    evidenceRef: safeIdentifierSchema(PUBLIC_PROSPECT_EVIDENCE_REFERENCE_MAX_LENGTH),
    policyVersion: boundedTextSchema(80)
  },
  required: [
    'method',
    'scope',
    'capturedAt',
    'capturedBy',
    'evidenceRef',
    'policyVersion'
  ],
  additionalProperties: false,
  maxProperties: 6
};

const candidateSubmittedProfileSchema: JsonSchema = {
  type: 'object',
  properties: {
    name: boundedTextSchema(160),
    email: boundedTextSchema(320),
    resumeText: boundedTextSchema(10000),
    skills: boundedTextArraySchema(30, 80),
    experienceYears: { type: 'number', minimum: 0, maximum: 100 }
  },
  required: ['name', 'email', 'resumeText'],
  additionalProperties: false,
  maxProperties: 5
};

const sourcedProspectSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: idSchema,
    source: { type: 'string', const: GITHUB_PROSPECT_SOURCE },
    sourceRecordId: boundedTextSchema(PUBLIC_PROSPECT_SOURCE_RECORD_MAX_LENGTH),
    profileUrl: boundedTextSchema(MAX_PROSPECT_URL_LENGTH),
    canonicalSourceUrl: boundedTextSchema(MAX_PROSPECT_URL_LENGTH),
    sourceQuery: publicProspectQuerySchema,
    sourceFilters: sourceFiltersSchema,
    fetchedAt: timestampSchema,
    importedAt: timestampSchema,
    dataOrigin: { type: 'string', const: GITHUB_PROSPECT_DATA_ORIGIN },
    consentStatus: {
      type: 'string',
      enum: PUBLIC_PROSPECT_CONSENT_STATUSES
    },
    consent: {
      type: ['object', 'null'] as const,
      properties: {
        method: {
          type: 'string',
          enum: PUBLIC_PROSPECT_CONSENT_METHODS
        },
        scope: boundedTextSchema(PUBLIC_PROSPECT_SCOPE_MAX_LENGTH),
        capturedAt: timestampSchema,
        capturedBy: actorContextSchema,
        evidenceRef: safeIdentifierSchema(PUBLIC_PROSPECT_EVIDENCE_REFERENCE_MAX_LENGTH),
        policyVersion: boundedTextSchema(80)
      },
      required: [
        'method',
        'scope',
        'capturedAt',
        'capturedBy',
        'evidenceRef',
        'policyVersion'
      ],
      additionalProperties: false
    },
    fieldOrigins: {
      type: 'object',
      maxProperties: MAX_PROVENANCE_FIELDS,
      additionalProperties: {
        type: 'string',
        enum: PUBLIC_PROSPECT_FIELD_ORIGINS
      }
    },
    attribution: publicProspectAttributionSchema,
    retentionExpiresAt: timestampSchema,
    withdrawnAt: timestampSchema,
    expiredAt: timestampSchema,
    candidateLinkOrigin: {
      type: 'string',
      enum: PUBLIC_PROSPECT_CANDIDATE_LINK_ORIGINS
    },
    candidateId: idSchema
  },
  required: [
    'id',
    'source',
    'sourceRecordId',
    'profileUrl',
    'canonicalSourceUrl',
    'sourceQuery',
    'fetchedAt',
    'importedAt',
    'dataOrigin',
    'consentStatus',
    'consent',
    'fieldOrigins',
    'attribution',
    'retentionExpiresAt'
  ],
  additionalProperties: false,
  maxProperties: 19
};

const comparisonScoreBreakdownSchema: JsonSchema = {
  type: 'object',
  properties: {
    requirementMatch: {
      type: 'object',
      properties: {
        matched: boundedTextArraySchema(50, 160),
        missing: boundedTextArraySchema(50, 160),
        score: { type: 'number', minimum: 0, maximum: 100 }
      },
      required: ['matched', 'missing', 'score'],
      additionalProperties: false
    },
    skillOverlap: {
      type: 'object',
      properties: {
        matched: boundedTextArraySchema(50, 160),
        score: { type: 'number', minimum: 0, maximum: 100 }
      },
      required: ['matched', 'score'],
      additionalProperties: false
    },
    experienceFit: {
      type: 'object',
      properties: {
        evidence: boundedTextSchema(500),
        score: { type: 'number', minimum: 0, maximum: 100 }
      },
      required: ['evidence', 'score'],
      additionalProperties: false
    }
  },
  required: ['requirementMatch', 'skillOverlap', 'experienceFit'],
  additionalProperties: false
};

const workflowApplicationSummarySchema: JsonSchema = {
  type: 'object',
  properties: {
    applicationId: safeIdentifierSchema(),
    candidateId: safeIdentifierSchema(),
    jobId: safeIdentifierSchema(),
    status: boundedTextSchema(80),
    currentStage: boundedTextSchema(100),
    blockers: boundedTextArraySchema(MAX_APPROVAL_SUMMARY_ITEMS, MAX_WORKFLOW_TEXT_LENGTH),
    nextActions: boundedTextArraySchema(MAX_APPROVAL_SUMMARY_ITEMS, MAX_WORKFLOW_TEXT_LENGTH)
  },
  required: [
    'applicationId',
    'candidateId',
    'jobId',
    'status',
    'currentStage',
    'blockers',
    'nextActions'
  ],
  additionalProperties: false
};

const traceSpanSchema: JsonSchema = {
  type: 'object',
  properties: {
    spanId: safeIdentifierSchema(),
    parentSpanId: safeIdentifierSchema(),
    name: boundedTextSchema(160),
    status: { type: 'string', enum: TRACE_SPAN_STATUSES },
    startedAt: timestampSchema,
    completedAt: timestampSchema,
    durationMs: { type: 'number', minimum: 0 },
    summary: {
      ...jsonObjectSchema,
      maxProperties: MAX_TRACE_SUMMARY_PROPERTIES
    }
  },
  required: ['spanId', 'name', 'status', 'startedAt'],
  additionalProperties: false,
  maxProperties: 7
};

const capabilityDescriptorSchema: JsonSchema = {
  type: 'object',
  properties: {
    name: boundedTextSchema(100),
    description: boundedTextSchema(500),
    visible: { type: 'boolean' },
    allowed: { type: 'boolean' },
    executionClass: { type: 'string', enum: OPERATION_EXECUTION_CLASSES },
    readOnlyHint: { type: 'boolean' },
    planable: { type: 'boolean' },
    requiresApproval: { type: 'boolean' },
    requiredCapability: boundedTextSchema(160),
    resourceScope: boundedTextSchema(160),
    schemaRef: boundedTextSchema(200),
    redactedFields: boundedTextArraySchema(30, 160),
    denialReason: { type: 'string', enum: CAPABILITY_DENIAL_REASONS }
  },
  required: [
    'name',
    'description',
    'visible',
    'allowed',
    'executionClass',
    'readOnlyHint',
    'planable',
    'requiresApproval',
    'requiredCapability',
    'resourceScope',
    'redactedFields'
  ],
  additionalProperties: false,
  maxProperties: 13
};

const capabilityManifestSchema: JsonSchema = {
  type: 'object',
  properties: {
    manifestVersion: boundedTextSchema(80),
    policyVersion: boundedTextSchema(PUBLIC_PROSPECT_POLICY_VERSION_MAX_LENGTH),
    actor: actorContextSchema,
    capabilities: {
      type: 'array',
      maxItems: MAX_CAPABILITIES,
      items: capabilityDescriptorSchema
    }
  },
  required: ['manifestVersion', 'policyVersion', 'actor', 'capabilities'],
  additionalProperties: false
};

export interface OperationDescriptorOptions {
  executionClass?: OperationExecutionClass;
  directlyCallable?: boolean;
  planable?: boolean;
  approvalPolicy?: ApprovalPolicy;
  /** See `OperationDescriptor.agentDirectExecution`. Defaults to `'allowed'`. */
  agentDirectExecution?: 'allowed' | 'forbidden';
  requiredCapability?: string;
}

const operationDescriptor = <N extends OperationName>(
  name: N,
  description: string,
  readOnly: boolean,
  inputSchema: JsonSchema,
  outputSchema: JsonSchema,
  options: OperationDescriptorOptions = {}
): OperationDescriptor<N> => {
  const executionClass = options.executionClass ?? (readOnly ? 'read' : 'commit');
  const directlyCallable = options.directlyCallable ?? true;
  const planable = options.planable ?? false;
  const approvalPolicy = options.approvalPolicy ?? 'none';
  const agentDirectExecution = options.agentDirectExecution ?? 'allowed';

  return {
    name,
    description,
    readOnly,
    readOnlyHint: readOnly,
    annotations: {
      readOnlyHint: readOnly,
      executionClass,
      requiresApproval: approvalPolicy !== 'none',
      planable
    },
    executionClass,
    directlyCallable,
    planable,
    approvalPolicy,
    agentDirectExecution,
    requiredCapability:
      options.requiredCapability ?? `pipeline.operation.${name}`,
    implementationKey: OPERATION_IMPLEMENTATION_KEYS[name],
    inputSchema,
    outputSchema
  };
};

/**
 * The one canonical registry.  Both the server validator and WebMCP adapter
 * must consume these descriptors rather than maintaining local schemas.
 */
export const OPERATION_REGISTRY = {
  create_job_requisition: operationDescriptor(
    'create_job_requisition',
    'Create a job requisition for an open role.',
    false,
    {
      type: 'object',
      properties: {
        title: requiredStringSchema,
        department: requiredStringSchema,
        requirements: {
          type: 'array',
          minItems: 1,
          items: requiredStringSchema
        },
        compBand: compensationBandSchema
      },
      required: ['title', 'department', 'requirements', 'compBand'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: { jobId: idSchema },
      required: ['jobId'],
      additionalProperties: false
    }
  ),

  list_open_jobs: operationDescriptor(
    'list_open_jobs',
    'List open jobs with the exact job IDs required by job-specific tools such as answer_candidate_faq.',
    true,
    {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        jobs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              jobId: idSchema,
              title: requiredStringSchema,
              department: requiredStringSchema,
              requirements: {
                type: 'array',
                items: requiredStringSchema
              },
              compBand: compensationBandSchema
            },
            required: ['jobId', 'title', 'department', 'requirements', 'compBand'],
            additionalProperties: false
          }
        }
      },
      required: ['jobs'],
      additionalProperties: false
    }
  ),

  search_candidates: operationDescriptor(
    'search_candidates',
    'Search and rank candidates by skills, keywords, and experience level.',
    true,
    {
      type: 'object',
      properties: {
        query: { type: 'string' },
        skills: {
          type: 'array',
          items: requiredStringSchema
        },
        experienceLevel: {
          type: 'string',
          enum: EXPERIENCE_LEVELS
        }
      },
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              candidateId: idSchema,
              name: requiredStringSchema,
              matchScore: { type: 'number', minimum: 0 },
              rationale: requiredStringSchema
            },
            required: ['candidateId', 'name', 'matchScore', 'rationale'],
            additionalProperties: false
          }
        }
      },
      required: ['results'],
      additionalProperties: false
    }
  ),

  search_public_candidates: operationDescriptor(
    'search_public_candidates',
    'Search allowlisted public GitHub profiles without creating candidate records.',
    true,
    {
      type: 'object',
      properties: {
        query: publicProspectQuerySchema,
        language: publicProspectInputTextSchema,
        location: publicProspectInputTextSchema
      },
      required: ['query'],
      additionalProperties: false
    },
    publicProspectSearchResultSchema,
    { requiredCapability: 'prospect.search' }
  ),

  get_candidate_profile: operationDescriptor(
    'get_candidate_profile',
    'Get a complete candidate profile and application history.',
    true,
    {
      type: 'object',
      properties: { candidateId: idSchema },
      required: ['candidateId'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        ...candidateRecordSchema.properties,
        applicationHistory: {
          type: 'array',
          items: applicationRecordSchema
        }
      },
      required: [
        'id',
        'name',
        'email',
        'resumeText',
        'skills',
        'experienceYears',
        'resumeTextHistory',
        'applicationHistory'
      ],
      additionalProperties: false
    }
  ),

  submit_application: operationDescriptor(
    'submit_application',
    'Submit a candidate application to an open job.',
    false,
    {
      type: 'object',
      properties: {
        candidateId: idSchema,
        jobId: idSchema,
        resumeText: requiredStringSchema
      },
      required: ['candidateId', 'jobId', 'resumeText'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        applicationId: idSchema,
        status: { type: 'string', const: 'applied' }
      },
      required: ['applicationId', 'status'],
      additionalProperties: false
    }
  ),

  screen_candidate: operationDescriptor(
    'screen_candidate',
    'Calculate and persist an explainable candidate screening score.',
    false,
    {
      type: 'object',
      properties: { applicationId: idSchema },
      required: ['applicationId'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        applicationId: idSchema,
        screeningScore: { type: 'number', minimum: 0, maximum: 100 },
        screeningRationale: requiredStringSchema,
        status: { type: 'string', const: 'screened' }
      },
      required: [
        'applicationId',
        'screeningScore',
        'screeningRationale',
        'status'
      ],
      additionalProperties: false
    }
  ),

  answer_candidate_faq: operationDescriptor(
    'answer_candidate_faq',
    'Answer a candidate question using only requisition data. Call list_open_jobs first to obtain the exact jobId.',
    true,
    {
      type: 'object',
      properties: {
        jobId: idSchema,
        question: requiredStringSchema
      },
      required: ['jobId', 'question'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        answer: requiredStringSchema,
        answeredFromData: { type: 'boolean' }
      },
      required: ['answer', 'answeredFromData'],
      additionalProperties: false
    }
  ),

  check_interviewer_availability: operationDescriptor(
    'check_interviewer_availability',
    'Find common free interview slots for every interviewer on a panel.',
    true,
    {
      type: 'object',
      properties: {
        panelId: idSchema,
        dateRange: dateRangeSchema
      },
      required: ['panelId', 'dateRange'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        commonFreeSlots: {
          type: 'array',
          items: timestampSchema
        }
      },
      required: ['commonFreeSlots'],
      additionalProperties: false
    }
  ),

  propose_interview_slots: operationDescriptor(
    'propose_interview_slots',
    'Propose up to three common interview slots for an application.',
    false,
    {
      type: 'object',
      properties: { applicationId: idSchema },
      required: ['applicationId'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        proposedSlots: {
          type: 'array',
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              interviewId: idSchema,
              slot: timestampSchema
            },
            required: ['interviewId', 'slot'],
            additionalProperties: false
          }
        }
      },
      required: ['proposedSlots'],
      additionalProperties: false
    }
  ),

  book_interview: operationDescriptor(
    'book_interview',
    'Book a proposed interview slot and cancel its sibling proposals.',
    false,
    {
      type: 'object',
      properties: {
        applicationId: idSchema,
        slot: timestampSchema
      },
      required: ['applicationId', 'slot'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        interviewId: idSchema,
        status: { type: 'string', const: 'booked' }
      },
      required: ['interviewId', 'status'],
      additionalProperties: false
    }
  ),

  get_interview_kit: operationDescriptor(
    'get_interview_kit',
    'Get the static competency-based interview kit for a role.',
    true,
    {
      type: 'object',
      properties: { jobId: idSchema },
      required: ['jobId'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        competencies: {
          type: 'array',
          minItems: 3,
          maxItems: 4,
          items: competencySchema
        }
      },
      required: ['competencies'],
      additionalProperties: false
    }
  ),

  submit_interview_feedback: operationDescriptor(
    'submit_interview_feedback',
    'Submit a structured interviewer scorecard.',
    false,
    {
      type: 'object',
      properties: {
        interviewId: idSchema,
        interviewer: requiredStringSchema,
        competencyScores: {
          type: 'object',
          minProperties: 1,
          additionalProperties: {
            type: 'number',
            minimum: 1,
            maximum: 5
          }
        },
        recommendation: {
          type: 'string',
          enum: SCORECARD_RECOMMENDATIONS
        },
        comments: requiredStringSchema
      },
      required: [
        'interviewId',
        'interviewer',
        'competencyScores',
        'recommendation',
        'comments'
      ],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: { scorecardId: idSchema },
      required: ['scorecardId'],
      additionalProperties: false
    }
  ),

  get_panel_feedback_summary: operationDescriptor(
    'get_panel_feedback_summary',
    'Summarize panel scorecards for an application.',
    true,
    {
      type: 'object',
      properties: { applicationId: idSchema },
      required: ['applicationId'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        averageScores: {
          type: 'object',
          additionalProperties: { type: 'number' }
        },
        recommendationTally: {
          type: 'object',
          properties: {
            strong_yes: { type: 'number', minimum: 0 },
            yes: { type: 'number', minimum: 0 },
            no: { type: 'number', minimum: 0 },
            strong_no: { type: 'number', minimum: 0 }
          },
          additionalProperties: false
        },
        scorecards: {
          type: 'array',
          items: scorecardRecordSchema
        }
      },
      required: ['averageScores', 'recommendationTally', 'scorecards'],
      additionalProperties: false
    }
  ),

  generate_offer: operationDescriptor(
    'generate_offer',
    'Generate a draft compensation offer for an application.',
    false,
    {
      type: 'object',
      properties: {
        applicationId: idSchema,
        compAmount: { type: 'number', minimum: 0 }
      },
      required: ['applicationId', 'compAmount'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        offerId: idSchema,
        status: { type: 'string', const: 'draft' }
      },
      required: ['offerId', 'status'],
      additionalProperties: false
    }
  ),

  send_offer: operationDescriptor(
    'send_offer',
    'Send a drafted offer to its candidate.',
    false,
    {
      type: 'object',
      properties: { offerId: idSchema },
      required: ['offerId'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        offerId: idSchema,
        status: { type: 'string', const: 'sent' }
      },
      required: ['offerId', 'status'],
      additionalProperties: false
    },
    // Sending an offer is an outbound, irreversible action. An autonomous
    // agent must not do it directly; a human recruiter performs it (or an
    // agent proposes it through plan/approve/commit).
    { agentDirectExecution: 'forbidden' }
  ),

  respond_to_offer: operationDescriptor(
    'respond_to_offer',
    'Accept, decline, or counter a sent offer.',
    false,
    {
      type: 'object',
      properties: {
        offerId: idSchema,
        decision: {
          type: 'string',
          enum: OFFER_DECISIONS
        },
        counterAmount: { type: 'number', minimum: 0 }
      },
      required: ['offerId', 'decision'],
      additionalProperties: false,
      oneOf: [
        {
          type: 'object',
          properties: {
            decision: {
              type: 'string',
              enum: ['accept', 'decline']
            }
          },
          required: ['decision']
        },
        {
          type: 'object',
          properties: {
            decision: { type: 'string', const: 'counter' },
            counterAmount: { type: 'number', minimum: 0 }
          },
          required: ['decision', 'counterAmount']
        }
      ]
    },
    {
      type: 'object',
      properties: {
        offerId: idSchema,
        status: {
          type: 'string',
          enum: OFFER_RESPONSE_STATUSES
        }
      },
      required: ['offerId', 'status'],
      additionalProperties: false
    },
    // Accepting/declining/countering an offer is an irreversible commitment.
    // A human candidate performs it; an autonomous agent may not.
    { agentDirectExecution: 'forbidden' }
  ),

  initiate_background_check: operationDescriptor(
    'initiate_background_check',
    'Initiate the deterministic background-check workflow for an accepted offer.',
    false,
    {
      type: 'object',
      properties: { offerId: idSchema },
      required: ['offerId'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        backgroundCheckId: idSchema,
        status: { type: 'string', enum: ['pending', 'clear'] }
      },
      required: ['backgroundCheckId', 'status'],
      additionalProperties: false
    }
  ),

  enroll_benefits: operationDescriptor(
    'enroll_benefits',
    'Enroll an offer in the selected medical, dental, and vision plans.',
    false,
    {
      type: 'object',
      properties: {
        offerId: idSchema,
        planSelections: {
          type: 'object',
          properties: {
            medical: requiredStringSchema,
            dental: requiredStringSchema,
            vision: requiredStringSchema
          },
          required: ['medical', 'dental', 'vision'],
          additionalProperties: false
        }
      },
      required: ['offerId', 'planSelections'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: { enrollmentId: idSchema },
      required: ['enrollmentId'],
      additionalProperties: false
    }
  ),

  generate_onboarding_checklist: operationDescriptor(
    'generate_onboarding_checklist',
    'Generate the role-specific onboarding checklist for an accepted offer.',
    false,
    {
      type: 'object',
      properties: { offerId: idSchema },
      required: ['offerId'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              taskId: idSchema,
              taskName: requiredStringSchema,
              dueDate: timestampSchema
            },
            required: ['taskId', 'taskName', 'dueDate'],
            additionalProperties: false
          }
        }
      },
      required: ['tasks'],
      additionalProperties: false
    }
  ),

  get_onboarding_status: operationDescriptor(
    'get_onboarding_status',
    'Get consolidated background-check, benefits, and task progress.',
    true,
    {
      type: 'object',
      properties: { offerId: idSchema },
      required: ['offerId'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        backgroundCheckStatus: {
          type: ['string', 'null'] as const,
          enum: [...BACKGROUND_CHECK_STATUSES, null]
        },
        benefitsEnrolled: { type: 'boolean' },
        taskCompletion: {
          type: 'object',
          properties: {
            done: { type: 'number', minimum: 0 },
            total: { type: 'number', minimum: 0 }
          },
          required: ['done', 'total'],
          additionalProperties: false
        },
        completionPercentage: { type: 'number', minimum: 0, maximum: 100 }
      },
      required: [
        'backgroundCheckStatus',
        'benefitsEnrolled',
        'taskCompletion',
        'completionPercentage'
      ],
      additionalProperties: false
    }
  ),

  plan_operation: operationDescriptor(
    'plan_operation',
    'Simulate a planable operation and create a reviewable approval card.',
    false,
    {
      type: 'object',
      properties: {
        targetOperation: { type: 'string', enum: PLANABLE_OPERATION_NAMES },
        input: jsonObjectSchema
      },
      required: ['targetOperation', 'input'],
      additionalProperties: false,
      maxProperties: 2
    },
    {
      type: 'object',
      properties: {
        approvalId: safeIdentifierSchema(),
        targetOperation: { type: 'string', enum: PLANABLE_OPERATION_NAMES },
        proposedOutput: jsonObjectSchema,
        changeSummary: boundedTextArraySchema(
          MAX_APPROVAL_SUMMARY_ITEMS,
          MAX_APPROVAL_TEXT_LENGTH
        ),
        warnings: boundedTextArraySchema(
          MAX_APPROVAL_SUMMARY_ITEMS,
          MAX_APPROVAL_TEXT_LENGTH
        ),
        blockers: boundedTextArraySchema(
          MAX_APPROVAL_SUMMARY_ITEMS,
          MAX_APPROVAL_TEXT_LENGTH
        ),
        baseRevision: { type: 'integer', minimum: 0 },
        expiresAt: timestampSchema,
        requiredApproval: { type: 'string', enum: APPROVAL_CARD_POLICIES },
        requiredCapability: boundedTextSchema(160),
        status: { type: 'string', const: 'pending' },
        policyVersion: boundedTextSchema(160),
        redactions: boundedTextArraySchema(MAX_APPROVAL_SUMMARY_ITEMS, 160)
      },
      required: [
        'approvalId',
        'targetOperation',
        'proposedOutput',
        'changeSummary',
        'warnings',
        'blockers',
        'baseRevision',
        'expiresAt',
        'requiredApproval',
        'requiredCapability',
        'status',
        'redactions'
      ],
      additionalProperties: false,
      maxProperties: 13
    },
    {
      executionClass: 'plan',
      planable: false,
      approvalPolicy: 'none',
      requiredCapability: 'workflow.plan'
    }
  ),

  get_approval_card: operationDescriptor(
    'get_approval_card',
    'Return an actor-scoped, redacted approval card.',
    true,
    {
      type: 'object',
      properties: { approvalId: safeIdentifierSchema() },
      required: ['approvalId'],
      additionalProperties: false
    },
    approvalCardSummarySchema,
    { executionClass: 'read', requiredCapability: 'workflow.approval.read' }
  ),

  approve_operation_plan: operationDescriptor(
    'approve_operation_plan',
    'Approve a pending operation plan without applying its target mutation.',
    false,
    {
      type: 'object',
      properties: {
        approvalId: safeIdentifierSchema(),
        note: boundedTextSchema(MAX_APPROVAL_TEXT_LENGTH)
      },
      required: ['approvalId'],
      additionalProperties: false,
      maxProperties: 2
    },
    {
      type: 'object',
      properties: {
        approvalId: safeIdentifierSchema(),
        status: { type: 'string', const: 'approved' },
        approvedBy: actorContextSchema,
        approvedAt: timestampSchema,
        note: boundedTextSchema(MAX_APPROVAL_TEXT_LENGTH),
        policyVersion: boundedTextSchema(160)
      },
      required: ['approvalId', 'status', 'approvedBy', 'approvedAt'],
      additionalProperties: false,
      maxProperties: 6
    },
    {
      executionClass: 'approval',
      approvalPolicy: 'human',
      requiredCapability: 'workflow.approval.approve'
    }
  ),

  reject_operation_plan: operationDescriptor(
    'reject_operation_plan',
    'Reject a pending operation plan without applying its target mutation.',
    false,
    {
      type: 'object',
      properties: {
        approvalId: safeIdentifierSchema(),
        note: boundedTextSchema(MAX_APPROVAL_TEXT_LENGTH)
      },
      required: ['approvalId'],
      additionalProperties: false,
      maxProperties: 2
    },
    {
      type: 'object',
      properties: {
        approvalId: safeIdentifierSchema(),
        status: { type: 'string', const: 'rejected' },
        rejectedBy: actorContextSchema,
        rejectedAt: timestampSchema,
        note: boundedTextSchema(MAX_APPROVAL_TEXT_LENGTH),
        policyVersion: boundedTextSchema(160)
      },
      required: ['approvalId', 'status', 'rejectedBy', 'rejectedAt'],
      additionalProperties: false,
      maxProperties: 6
    },
    {
      executionClass: 'approval',
      approvalPolicy: 'human',
      requiredCapability: 'workflow.approval.reject'
    }
  ),

  commit_operation_plan: operationDescriptor(
    'commit_operation_plan',
    'Commit one approved and unexpired operation plan atomically.',
    false,
    {
      type: 'object',
      properties: { approvalId: safeIdentifierSchema() },
      required: ['approvalId'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        approvalId: safeIdentifierSchema(),
        targetOperation: boundedTextSchema(100),
        status: { type: 'string', const: 'committed' },
        output: jsonObjectSchema,
        committedAt: timestampSchema,
        redactions: boundedTextArraySchema(MAX_APPROVAL_SUMMARY_ITEMS, 160)
      },
      required: [
        'approvalId',
        'targetOperation',
        'status',
        'output',
        'committedAt'
      ],
      additionalProperties: false,
      maxProperties: 6
    },
    {
      executionClass: 'commit',
      approvalPolicy: 'human',
      requiredCapability: 'workflow.plan.commit'
    }
  ),

  compare_candidates: operationDescriptor(
    'compare_candidates',
    'Compare two to five permitted candidates against one job with explainable scoring.',
    true,
    {
      type: 'object',
      properties: {
        jobId: idSchema,
        candidateIds: {
          type: 'array',
          minItems: 2,
          maxItems: MAX_COMPARISON_CANDIDATES,
          uniqueItems: true,
          items: idSchema
        }
      },
      required: ['jobId', 'candidateIds'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        jobId: idSchema,
        revision: { type: 'integer', minimum: 0 },
        candidates: {
          type: 'array',
          minItems: 2,
          maxItems: MAX_COMPARISON_CANDIDATES,
          items: {
            type: 'object',
            properties: {
              candidateId: idSchema,
              name: requiredStringSchema,
              rank: { type: 'integer', minimum: 1, maximum: MAX_COMPARISON_CANDIDATES },
              totalScore: { type: 'number', minimum: 0, maximum: 100 },
              scoreBreakdown: comparisonScoreBreakdownSchema,
              rationale: boundedTextSchema(1000),
              limitations: boundedTextArraySchema(MAX_APPROVAL_SUMMARY_ITEMS, 300)
            },
            required: [
              'candidateId',
              'name',
              'rank',
              'totalScore',
              'scoreBreakdown',
              'rationale',
              'limitations'
            ],
            additionalProperties: false
          }
        }
      },
      required: ['jobId', 'revision', 'candidates'],
      additionalProperties: false
    },
    { executionClass: 'read', requiredCapability: 'candidate.compare' }
  ),

  get_recruiting_workflow_status: operationDescriptor(
    'get_recruiting_workflow_status',
    'Return a bounded, role-scoped recruiting workflow status snapshot.',
    true,
    {
      type: 'object',
      properties: {
        jobId: idSchema,
        applicationId: idSchema,
        candidateId: idSchema,
        detail: { type: 'string', enum: ['summary', 'full'] },
        limit: { type: 'integer', minimum: 1, maximum: MAX_WORKFLOW_STATUS_ITEMS }
      },
      additionalProperties: false,
      maxProperties: 5
    },
    {
      type: 'object',
      properties: {
        revision: { type: 'integer', minimum: 0 },
        scope: {
          type: 'object',
          properties: {
            jobId: idSchema,
            applicationId: idSchema,
            candidateId: idSchema
          },
          additionalProperties: false,
          maxProperties: 3
        },
        countsByApplicationStatus: {
          type: 'object',
          maxProperties: 12,
          additionalProperties: { type: 'integer', minimum: 0 }
        },
        applications: {
          type: 'array',
          maxItems: MAX_WORKFLOW_STATUS_ITEMS,
          items: workflowApplicationSummarySchema
        },
        pendingApprovals: {
          type: 'array',
          maxItems: MAX_APPROVAL_RECORDS,
          items: approvalCardSummarySchema
        },
        blockers: boundedTextArraySchema(MAX_APPROVAL_SUMMARY_ITEMS, MAX_WORKFLOW_TEXT_LENGTH),
        nextActions: boundedTextArraySchema(MAX_APPROVAL_SUMMARY_ITEMS, MAX_WORKFLOW_TEXT_LENGTH),
        generatedAt: timestampSchema
      },
      required: [
        'revision',
        'scope',
        'countsByApplicationStatus',
        'applications',
        'pendingApprovals',
        'blockers',
        'nextActions',
        'generatedAt'
      ],
      additionalProperties: false
    },
    { executionClass: 'read', requiredCapability: 'workflow.status.read' }
  ),

  import_public_prospect: operationDescriptor(
    'import_public_prospect',
    'Import an explicitly consented public prospect with immutable provenance.',
    false,
    {
      type: 'object',
      properties: {
        ...publicProspectSourceReferenceSchema.properties,
        consent: consentSchema,
        candidateProfile: candidateSubmittedProfileSchema
      },
      required: [...(publicProspectSourceReferenceSchema.required ?? []), 'consent'],
      additionalProperties: false,
      maxProperties: 10
    },
    {
      type: 'object',
      properties: {
        sourcedProspect: sourcedProspectSchema,
        candidateId: idSchema,
        status: { type: 'string', enum: ['imported', 'linked'] }
      },
      required: ['sourcedProspect', 'status'],
      additionalProperties: false
    },
    {
      executionClass: 'commit',
      planable: true,
      approvalPolicy: 'consent_and_human',
      agentDirectExecution: 'forbidden',
      requiredCapability: 'prospect.import'
    }
  ),

  revoke_public_prospect_consent: operationDescriptor(
    'revoke_public_prospect_consent',
    'Withdraw public-prospect consent and apply the configured retention action.',
    false,
    {
      type: 'object',
      properties: {
        sourcedProspectId: idSchema,
        reason: boundedTextSchema(500)
      },
      required: ['sourcedProspectId'],
      additionalProperties: false,
      maxProperties: 2
    },
    {
      type: 'object',
      properties: {
        sourcedProspectId: idSchema,
        status: { type: 'string', const: 'withdrawn' },
        withdrawnAt: timestampSchema,
        retentionAction: boundedTextSchema(300)
      },
      required: [
        'sourcedProspectId',
        'status',
        'withdrawnAt',
        'retentionAction'
      ],
      additionalProperties: false
    },
    { executionClass: 'commit', approvalPolicy: 'human', requiredCapability: 'prospect.consent.revoke' }
  ),

  coordinate_interview_workflow: operationDescriptor(
    'coordinate_interview_workflow',
    'Coordinate deterministic interview proposal or booking workflow steps.',
    false,
    {
      type: 'object',
      properties: {
        applicationId: idSchema,
        action: { type: 'string', enum: ['propose_slots', 'book_slot'] },
        slot: timestampSchema
      },
      required: ['applicationId', 'action'],
      additionalProperties: false,
      oneOf: [
        {
          type: 'object',
          properties: { action: { type: 'string', const: 'propose_slots' } },
          required: ['action']
        },
        {
          type: 'object',
          properties: {
            action: { type: 'string', const: 'book_slot' },
            slot: timestampSchema
          },
          required: ['action', 'slot']
        }
      ]
    },
    {
      type: 'object',
      properties: {
        applicationId: idSchema,
        stage: boundedTextSchema(100),
        proposedSlots: {
          type: 'array',
          maxItems: 3,
          items: {
            type: 'object',
            properties: { interviewId: idSchema, slot: timestampSchema },
            required: ['interviewId', 'slot'],
            additionalProperties: false
          }
        },
        bookedInterview: {
          type: ['object', 'null'] as const,
          properties: { interviewId: idSchema, slot: timestampSchema },
          required: ['interviewId', 'slot'],
          additionalProperties: false
        },
        nextAction: { type: ['string', 'null'] as const, maxLength: 300 },
        blockers: boundedTextArraySchema(MAX_APPROVAL_SUMMARY_ITEMS, MAX_WORKFLOW_TEXT_LENGTH)
      },
      required: [
        'applicationId',
        'stage',
        'proposedSlots',
        'bookedInterview',
        'nextAction',
        'blockers'
      ],
      additionalProperties: false
    },
    {
      executionClass: 'commit',
      planable: true,
      approvalPolicy: 'human',
      requiredCapability: 'interview.coordinate'
    }
  ),

  coordinate_onboarding_workflow: operationDescriptor(
    'coordinate_onboarding_workflow',
    'Coordinate deterministic onboarding checklist initialization and task updates.',
    false,
    {
      type: 'object',
      properties: {
        offerId: idSchema,
        action: { type: 'string', enum: ['initialize_checklist', 'update_task'] },
        taskId: idSchema,
        status: { type: 'string', enum: ONBOARDING_TASK_STATUSES }
      },
      required: ['offerId', 'action'],
      additionalProperties: false,
      oneOf: [
        {
          type: 'object',
          properties: { action: { type: 'string', const: 'initialize_checklist' } },
          required: ['action']
        },
        {
          type: 'object',
          properties: {
            action: { type: 'string', const: 'update_task' },
            taskId: idSchema,
            status: { type: 'string', enum: ONBOARDING_TASK_STATUSES }
          },
          required: ['action', 'taskId', 'status']
        }
      ]
    },
    {
      type: 'object',
      properties: {
        offerId: idSchema,
        changedTasks: {
          type: 'array',
          maxItems: MAX_WORKFLOW_STATUS_ITEMS,
          items: {
            type: 'object',
            properties: {
              taskId: idSchema,
              taskName: boundedTextSchema(200),
              dueDate: timestampSchema,
              status: { type: 'string', enum: ONBOARDING_TASK_STATUSES }
            },
            required: ['taskId', 'taskName', 'dueDate', 'status'],
            additionalProperties: false
          }
        },
        backgroundCheckStatus: {
          type: ['string', 'null'] as const,
          enum: [...BACKGROUND_CHECK_STATUSES, null]
        },
        benefitsEnrolled: { type: 'boolean' },
        taskCompletion: {
          type: 'object',
          properties: {
            done: { type: 'integer', minimum: 0 },
            total: { type: 'integer', minimum: 0 }
          },
          required: ['done', 'total'],
          additionalProperties: false
        },
        completionPercentage: { type: 'number', minimum: 0, maximum: 100 },
        blockers: boundedTextArraySchema(MAX_APPROVAL_SUMMARY_ITEMS, MAX_WORKFLOW_TEXT_LENGTH),
        nextActions: boundedTextArraySchema(MAX_APPROVAL_SUMMARY_ITEMS, MAX_WORKFLOW_TEXT_LENGTH)
      },
      required: [
        'offerId',
        'changedTasks',
        'backgroundCheckStatus',
        'benefitsEnrolled',
        'taskCompletion',
        'completionPercentage',
        'blockers',
        'nextActions'
      ],
      additionalProperties: false
    },
    {
      executionClass: 'commit',
      planable: true,
      approvalPolicy: 'human',
      requiredCapability: 'onboarding.coordinate'
    }
  ),

  discover_capabilities: operationDescriptor(
    'discover_capabilities',
    'Return the actor-scoped operation capability and permission manifest.',
    true,
    {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
      maxProperties: 0
    },
    capabilityManifestSchema,
    { executionClass: 'read', requiredCapability: 'capabilities.discover' }
  )
} as const satisfies OperationRegistry;

/** Alias with a descriptive lower-case name for consumers that prefer it. */
export const operationRegistry = OPERATION_REGISTRY;
export const OPERATION_DESCRIPTORS = OPERATION_REGISTRY;
export const OPERATIONS = OPERATION_REGISTRY;

export function isOperationName(value: unknown): value is OperationName {
  return (
    typeof value === 'string' &&
    (OPERATION_NAMES as readonly string[]).includes(value)
  );
}

export function getOperationDescriptor<N extends OperationName>(
  name: N
): OperationDescriptor<N> {
  return OPERATION_REGISTRY[name] as OperationDescriptor<N>;
}

export function getOperationNames(): OperationName[] {
  return [...OPERATION_NAMES];
}

/** Compile-time helper for code that dispatches by operation name. */
export type OperationInput<N extends OperationName> = OperationInputMap[N];
export type OperationOutput<N extends OperationName> = OperationOutputMap[N];

/** A metadata-aware invocation envelope; metadata is transport context, not operation input. */
export interface OperationInvocation<N extends OperationName = OperationName> {
  name: N;
  input: OperationInput<N>;
  actor: ActorContext;
  metadata?: InvocationMetadata;
}

export type Invocation = OperationInvocation;

// Keep these imports type-visible to consumers that use the operation module
// as their single contract entry point.
export type {
  ActivityLogEntry,
  ActivityPhase,
  ActorContext,
  ApprovalCard,
  ApprovalCardPolicy,
  ApprovalCardRecord,
  ApprovalCardStatus,
  ApprovalCardSummary,
  ApprovalId,
  ApprovalPolicy,
  ApplicationRecord,
  BackgroundCheckStatus,
  CandidateRecord,
  CapabilityDescriptor,
  CapabilityManifest,
  CompensationBand,
  CorrelationId,
  DateRange,
  ExperienceLevel,
  GeneratedIdPlaceholder,
  InvocationMetadata,
  JobRequisition,
  JsonObject,
  OfferDecision,
  OfferResponseStatus,
  OperationExecutionClass,
  PlanSelections,
  ScorecardRecord,
  ScorecardRecommendation,
  SourcedProspectId,
  SpanId,
  StartDate,
  TaskCompletion,
  Timestamp,
  TraceId,
  TraceSpan,
  TraceSpanStatus
};

export type {
  CandidateSubmittedProfile,
  GitHubProspect,
  GitHubProspectAttribution,
  GitHubProspectCacheMetadata,
  GitHubProspectSearchInput,
  GitHubProspectSearchResult,
  NormalizedGitHubProspectSearchInput,
  PublicProspectConsent,
  PublicProspectFieldOrigin,
  PublicProspectSourceReference,
  SourcedProspectRecord
};
