/**
 * Isomorphic domain contracts shared by the server, client, and operation
 * adapters. Timestamps are kept as ISO-compatible strings so no Date instances
 * or other runtime-only values cross the JSON state boundary.
 */

import type { SourcedProspectRecord } from './publicProspects';
export type { SourcedProspectRecord };

/** A JSON-safe timestamp serialized as an ISO 8601 string. */
export type Timestamp = string;
export type ISO8601Timestamp = Timestamp;

/** Stable identifier aliases make relationships explicit without runtime wrappers. */
export type EntityId = string;
export type JobId = EntityId;
export type CandidateId = EntityId;
export type ApplicationId = EntityId;
export type PanelId = EntityId;
export type InterviewId = EntityId;
export type ScorecardId = EntityId;
export type OfferId = EntityId;
export type OnboardingTaskId = EntityId;
export type BackgroundCheckId = EntityId;
export type BenefitsEnrollmentId = EntityId;
export type ActivityId = EntityId;
export type ApprovalId = EntityId;
export type CorrelationId = string;
export type IdempotencyKey = string;
export type RoleTemplateId = EntityId;
export type InterviewerId = EntityId;
export type SourcedProspectId = EntityId;
export type SpanId = string;
export type TraceId = string;

/** IDs emitted by a plan are placeholders and never consume a commit ID. */
export const GENERATED_ID_PLACEHOLDER_PREFIX = 'preview-';
export type GeneratedIdPlaceholder = `${typeof GENERATED_ID_PLACEHOLDER_PREFIX}${string}`;

export interface GeneratedIdReference {
  value: string;
  entityType: string;
  placeholder: boolean;
}

/** Bounded transport metadata limits shared by clients and server validators. */
export const INVOCATION_METADATA_LIMITS = {
  correlationId: 128,
  idempotencyKey: 256,
  approvalId: 128,
  parentSpanId: 128
} as const;

/** Recursive JSON types used by the persisted activity log. */
export type JsonPrimitive = string | number | boolean | null;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonArray = JsonValue[];
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/** Canonical lifecycle and actor values. */
export const JOB_STATUSES = ['open', 'paused', 'closed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export type JobRequisitionStatus = JobStatus;

export const APPLICATION_STATUSES = [
  'applied',
  'screened',
  'interviewing',
  'offer_sent',
  'offer_accepted',
  'offer_declined',
  'rejected',
  'onboarding'
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
export type ApplicationLifecycleStatus = ApplicationStatus;

export const INTERVIEW_STATUSES = [
  'proposed',
  'booked',
  'completed',
  'cancelled'
] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];
export type InterviewRecordStatus = InterviewStatus;

export const SCORECARD_RECOMMENDATIONS = [
  'strong_yes',
  'yes',
  'no',
  'strong_no'
] as const;
export type ScorecardRecommendation = (typeof SCORECARD_RECOMMENDATIONS)[number];
export type InterviewRecommendation = ScorecardRecommendation;

export const OFFER_STATUSES = [
  'draft',
  'sent',
  'accepted',
  'declined',
  'countered'
] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];
export type OfferLifecycleStatus = OfferStatus;

export const ONBOARDING_TASK_STATUSES = [
  'pending',
  'in_progress',
  'complete'
] as const;
export type OnboardingTaskStatus = (typeof ONBOARDING_TASK_STATUSES)[number];
export type TaskStatus = OnboardingTaskStatus;

export const BACKGROUND_CHECK_STATUSES = ['pending', 'clear', 'flagged'] as const;
export type BackgroundCheckStatus = (typeof BACKGROUND_CHECK_STATUSES)[number];

export const ACTOR_TYPES = ['human_ui', 'agent'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const OPERATION_EXECUTION_CLASSES = [
  'read',
  'plan',
  'approval',
  'commit'
] as const;
export type OperationExecutionClass =
  (typeof OPERATION_EXECUTION_CLASSES)[number];
export type ExecutionClass = OperationExecutionClass;

export const APPROVAL_POLICIES = [
  'none',
  'agent',
  'human',
  'consent_and_human'
] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

export const APPROVAL_CARD_POLICIES = ['human', 'consent_and_human'] as const;
export type ApprovalCardPolicy = (typeof APPROVAL_CARD_POLICIES)[number];

export const APPROVAL_CARD_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'committed'
] as const;
export type ApprovalCardStatus = (typeof APPROVAL_CARD_STATUSES)[number];

export const APPROVAL_RECORD_EFFECTS = ['create', 'update', 'withdraw'] as const;
export type ApprovalRecordEffect = (typeof APPROVAL_RECORD_EFFECTS)[number];

export const ACTIVITY_PHASES = [
  'read',
  'plan',
  'approval',
  'commit',
  'replay'
] as const;
export type ActivityPhase = (typeof ACTIVITY_PHASES)[number];

export const TRACE_SPAN_STATUSES = [
  'started',
  'completed',
  'failed',
  'skipped'
] as const;
export type TraceSpanStatus = (typeof TRACE_SPAN_STATUSES)[number];

export interface InvocationMetadata {
  correlationId?: CorrelationId;
  idempotencyKey?: IdempotencyKey;
  expectedRevision?: number;
  approvalId?: ApprovalId;
  parentSpanId?: SpanId;
}

export const OFFER_DECISIONS = ['accept', 'decline', 'counter'] as const;
export type OfferDecision = (typeof OFFER_DECISIONS)[number];

export const OFFER_RESPONSE_STATUSES = ['accepted', 'declined', 'countered'] as const;
export type OfferResponseStatus = (typeof OFFER_RESPONSE_STATUSES)[number];

export const EXPERIENCE_LEVELS = ['junior', 'mid', 'senior'] as const;
export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];

/** Value objects shared by operation inputs and domain records. */
export interface CompensationBand {
  min: number;
  max: number;
  currency: string;
}

export interface DateRange {
  start: Timestamp;
  end: Timestamp;
}

export interface ApplicationNote {
  author: string;
  text: string;
  at: Timestamp;
}

export interface Interviewer {
  id: InterviewerId;
  name: string;
  role: string;
}

export interface PlanSelections {
  medical: string;
  dental: string;
  vision: string;
}

export interface CompetencyGroup {
  name: string;
  questions: string[];
}

export interface OnboardingTaskTemplate {
  taskName: string;
  offsetDays: number;
}

/**
 * A static role template. `roleMatcher` is a JSON-safe matcher token used by
 * the domain layer to select a template from a requisition.
 */
export interface RoleTemplate {
  id: RoleTemplateId;
  roleMatcher: string;
  competencies: CompetencyGroup[];
  onboardingTasks: OnboardingTaskTemplate[];
}

export type StartDate = Timestamp;

export interface TaskCompletion {
  done: number;
  total: number;
}

export interface OnboardingStatus {
  backgroundCheckStatus: BackgroundCheckStatus | null;
  benefitsEnrolled: boolean;
  taskCompletion: TaskCompletion;
  completionPercentage: number;
}

/** Normative domain records. */
export interface JobRequisition {
  id: JobId;
  title: string;
  department: string;
  requirements: string[];
  compBand: CompensationBand;
  status: JobStatus;
  createdBy: string;
  createdAt: Timestamp;
}

export interface CandidateRecord {
  id: CandidateId;
  name: string;
  email: string;
  resumeText: string;
  skills: string[];
  experienceYears: number;
  resumeTextHistory: string[];
}

export interface ApplicationRecord {
  id: ApplicationId;
  candidateId: CandidateId;
  jobId: JobId;
  status: ApplicationStatus;
  screeningScore: number | null;
  screeningRationale: string | null;
  notes: ApplicationNote[];
  createdAt: Timestamp;
}

export interface InterviewPanel {
  id: PanelId;
  jobId: JobId;
  interviewers: Interviewer[];
}

export interface InterviewRecord {
  id: InterviewId;
  applicationId: ApplicationId;
  panelId: PanelId;
  slot: Timestamp;
  status: InterviewStatus;
}

export interface ScorecardRecord {
  id: ScorecardId;
  interviewId: InterviewId;
  interviewer: string;
  competencyScores: Record<string, number>;
  recommendation: ScorecardRecommendation;
  comments: string;
  submittedAt: Timestamp;
}

export interface OfferRecord {
  id: OfferId;
  applicationId: ApplicationId;
  compAmount: number;
  currency: string;
  status: OfferStatus;
  counterAmount: number | null;
  sentAt: Timestamp | null;
  respondedAt: Timestamp | null;
  /** Non-blocking warning retained when compAmount is outside the job band. */
  compensationWarning?: string;
}

export interface OnboardingTaskRecord {
  id: OnboardingTaskId;
  offerId: OfferId;
  taskName: string;
  status: OnboardingTaskStatus;
  dueDate: Timestamp;
}

export interface BackgroundCheckRecord {
  id: BackgroundCheckId;
  offerId: OfferId;
  status: BackgroundCheckStatus;
  initiatedAt: Timestamp;
  completedAt: Timestamp | null;
}

export interface BenefitsEnrollmentRecord {
  id: BenefitsEnrollmentId;
  offerId: OfferId;
  planSelections: PlanSelections;
  enrolledAt: Timestamp;
}

export interface ActorContext {
  actorType: ActorType;
  actorId: string;
}

export interface ApprovalAffectedRecord {
  type: string;
  id: EntityId | GeneratedIdPlaceholder;
  effect: ApprovalRecordEffect;
}

/** Internal approval-card record. normalizedInput is never a public projection. */
export interface ApprovalCardRecord {
  id: ApprovalId;
  targetOperation: string;
  normalizedInput: JsonObject;
  requestFingerprint: string;
  requestedBy: ActorContext;
  requestedAt: Timestamp;
  baseRevision: number;
  targetFingerprint: string;
  affectedRecords: ApprovalAffectedRecord[];
  proposedOutput: JsonObject;
  changeSummary: string[];
  warnings: string[];
  /** Safe workflow blockers surfaced by the planned target, when any. */
  blockers?: string[];
  requiredCapability: string;
  approvalPolicy: ApprovalCardPolicy;
  /** Policy version captured at plan time for commit-time revalidation. */
  policyVersion?: string;
  status: ApprovalCardStatus;
  approvalNote?: string;
  rejectionNote?: string;
  approvedBy?: ActorContext;
  approvedAt?: Timestamp;
  rejectedBy?: ActorContext;
  rejectedAt?: Timestamp;
  expiresAt: Timestamp;
  correlationId: CorrelationId;
  traceId: TraceId;
  committedAt?: Timestamp;
}

/** Actor-scoped card view; protected normalized input and fingerprints are omitted. */
export interface ApprovalCardSummary {
  id: ApprovalId;
  targetOperation: string;
  requestedBy: ActorContext;
  requestedAt: Timestamp;
  baseRevision: number;
  affectedRecords: ApprovalAffectedRecord[];
  proposedOutput: JsonObject;
  changeSummary: string[];
  warnings: string[];
  blockers?: string[];
  requiredCapability: string;
  approvalPolicy: ApprovalCardPolicy;
  policyVersion?: string;
  status: ApprovalCardStatus;
  approvalNote?: string;
  rejectionNote?: string;
  approvedBy?: ActorContext;
  approvedAt?: Timestamp;
  rejectedBy?: ActorContext;
  rejectedAt?: Timestamp;
  expiresAt: Timestamp;
  correlationId: CorrelationId;
  traceId: TraceId;
  committedAt?: Timestamp;
  redactions?: string[];
}

export type ApprovalCard = ApprovalCardSummary;

export interface TraceSpan {
  spanId: SpanId;
  parentSpanId?: SpanId;
  name: string;
  status: TraceSpanStatus;
  startedAt: Timestamp;
  completedAt?: Timestamp;
  durationMs?: number;
  summary?: JsonObject;
}

export interface ActivityTrace {
  spans: TraceSpan[];
}

export const CAPABILITY_DENIAL_REASONS = [
  'actor_not_authenticated',
  'capability_denied',
  'resource_scope',
  'approval_only'
] as const;
export type CapabilityDenialReason = (typeof CAPABILITY_DENIAL_REASONS)[number];

export interface CapabilityDescriptor {
  name: string;
  description: string;
  visible: boolean;
  allowed: boolean;
  executionClass: OperationExecutionClass;
  readOnlyHint: boolean;
  planable: boolean;
  requiresApproval: boolean;
  requiredCapability: string;
  resourceScope: string;
  schemaRef?: string;
  redactedFields: string[];
  denialReason?: CapabilityDenialReason;
}

export interface CapabilityManifest {
  manifestVersion: string;
  policyVersion: string;
  actor: ActorContext;
  capabilities: CapabilityDescriptor[];
}

export interface ActivityLogEntry {
  id: ActivityId;
  toolName: string;
  actorType: ActorType;
  actorId: string;
  input: JsonObject;
  output: JsonObject;
  timestamp: Timestamp;
  correlationId?: CorrelationId;
  traceId?: TraceId;
  spanId?: SpanId;
  parentSpanId?: SpanId;
  phase?: ActivityPhase;
  replayed?: boolean;
  originalActivityId?: ActivityId;
  approvalId?: ApprovalId;
  redactions?: string[];
  trace?: ActivityTrace;
}

/**
 * Read-only catalogs used by operations. Maps are retained internally for
 * availability lookup; their projection counterpart below is array-based.
 */
export type AvailabilityCalendar = Map<InterviewerId, Timestamp[]>;

export interface AvailabilityCalendarEntry {
  interviewerId: InterviewerId;
  freeSlots: Timestamp[];
}

export interface PlanCatalog {
  medical: string[];
  dental: string[];
  vision: string[];
}

export interface SharedCatalogs {
  availabilityCalendar: AvailabilityCalendar;
  roleTemplates: RoleTemplate[];
  planCatalog: PlanCatalog;
  startDate: StartDate;
}

export interface SharedCatalogProjection {
  availabilityCalendar: AvailabilityCalendarEntry[];
  roleTemplates: RoleTemplate[];
  planCatalog: PlanCatalog;
  startDate: StartDate;
}

export type CatalogState = SharedCatalogs;
export type SerializedCatalogState = SharedCatalogProjection;

/**
 * Mutable repository state. Domain collections are maps for keyed lookup and
 * activityLog preserves append order for the live activity feed. Approval and
 * sourced-prospect records live beside the legacy collections so a successful
 * transaction can publish them atomically with its activity entry.
 */
export interface SharedStateCollections {
  jobs: Map<JobId, JobRequisition>;
  candidates: Map<CandidateId, CandidateRecord>;
  applications: Map<ApplicationId, ApplicationRecord>;
  panels: Map<PanelId, InterviewPanel>;
  interviews: Map<InterviewId, InterviewRecord>;
  scorecards: Map<ScorecardId, ScorecardRecord>;
  offers: Map<OfferId, OfferRecord>;
  onboardingTasks: Map<OnboardingTaskId, OnboardingTaskRecord>;
  backgroundChecks: Map<BackgroundCheckId, BackgroundCheckRecord>;
  benefitsEnrollments: Map<BenefitsEnrollmentId, BenefitsEnrollmentRecord>;
  approvalCards: Map<ApprovalId, ApprovalCardRecord>;
  sourcedProspects: Map<SourcedProspectId, SourcedProspectRecord>;
  activityLog: ActivityLogEntry[];
}

export interface SharedState extends SharedStateCollections {
  revision: number;
}

export interface SharedStateWithCatalogs extends SharedState {
  catalogs: SharedCatalogs;
}

/**
 * Pre-P11.3 seed shapes accepted by the repository during migration. These
 * aliases intentionally retain every legacy collection name while allowing
 * normalizeSeed() to add the new maps with empty defaults.
 */
export type LegacySharedStateCollections = Omit<
  SharedStateCollections,
  'approvalCards' | 'sourcedProspects'
>;

export interface LegacySharedState extends LegacySharedStateCollections {
  revision: number;
}

export interface LegacySharedStateWithCatalogs extends LegacySharedState {
  catalogs: SharedCatalogs;
}

/**
 * JSON-safe state returned by the state endpoint and hydrated into Zustand.
 * Collection names intentionally match SharedState; map-backed collections
 * become stable arrays while activity entries retain append order. The two
 * additive arrays are optional at this boundary so an older server payload can
 * still hydrate a newer client; the store normalizes missing values to [].
 */
export interface SharedStateProjection {
  revision: number;
  jobs: JobRequisition[];
  candidates: CandidateRecord[];
  applications: ApplicationRecord[];
  panels: InterviewPanel[];
  interviews: InterviewRecord[];
  scorecards: ScorecardRecord[];
  offers: OfferRecord[];
  onboardingTasks: OnboardingTaskRecord[];
  backgroundChecks: BackgroundCheckRecord[];
  benefitsEnrollments: BenefitsEnrollmentRecord[];
  approvalCards?: ApprovalCardSummary[];
  sourcedProspects?: SourcedProspectRecord[];
  activityLog: ActivityLogEntry[];
}

export type SharedStateArrayProjection = SharedStateProjection;
export type SerializedSharedState = SharedStateProjection;
export type JsonSafeSharedState = SharedStateProjection;

export interface SharedStateProjectionWithCatalogs extends SharedStateProjection {
  catalogs: SharedCatalogProjection;
}

export type SerializedSharedStateWithCatalogs = SharedStateProjectionWithCatalogs;
