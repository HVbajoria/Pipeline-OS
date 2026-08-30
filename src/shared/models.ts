/**
 * Isomorphic domain contracts shared by the server, client, and operation
 * adapters. Timestamps are kept as ISO-compatible strings so no Date instances
 * or other runtime-only values cross the JSON state boundary.
 */

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
export type RoleTemplateId = EntityId;
export type InterviewerId = EntityId;

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

export interface ActivityLogEntry {
  id: ActivityId;
  toolName: string;
  actorType: ActorType;
  actorId: string;
  input: JsonObject;
  output: JsonObject;
  timestamp: Timestamp;
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
 * activityLog preserves append order for the live activity feed.
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
  activityLog: ActivityLogEntry[];
}

export interface SharedState extends SharedStateCollections {
  revision: number;
}

export interface SharedStateWithCatalogs extends SharedState {
  catalogs: SharedCatalogs;
}

/**
 * JSON-safe state returned by the state endpoint and hydrated into Zustand.
 * Collection names intentionally match SharedState; map-backed collections
 * become stable arrays while activity entries retain append order.
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
  activityLog: ActivityLogEntry[];
}

export type SharedStateArrayProjection = SharedStateProjection;
export type SerializedSharedState = SharedStateProjection;
export type JsonSafeSharedState = SharedStateProjection;

export interface SharedStateProjectionWithCatalogs extends SharedStateProjection {
  catalogs: SharedCatalogProjection;
}

export type SerializedSharedStateWithCatalogs = SharedStateProjectionWithCatalogs;
