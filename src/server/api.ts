/** Express boundary for canonical operations and legacy compatibility aliases. */

import { randomUUID } from 'node:crypto';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response
} from 'express';
import type {
  ActivityLogEntry,
  ActivityTrace,
  ActorContext,
  ApprovalCardRecord,
  ApprovalCardSummary,
  ApplicationRecord,
  BackgroundCheckRecord,
  BenefitsEnrollmentRecord,
  CandidateRecord,
  InterviewPanel,
  InterviewRecord,
  InvocationMetadata,
  JobRequisition,
  JsonObject,
  OfferRecord,
  OnboardingTaskRecord,
  ScorecardRecord,
  SharedStateProjectionWithCatalogs,
  SharedStateWithCatalogs,
  TraceSpan
} from '../shared/models';
import type { SourcedProspectRecord } from '../shared/publicProspects';
import { ConflictError, PipelineError, ValidationError } from '../shared/errors';
import { normalizeInvocationMetadata } from '../shared/domain/invocationMetadata';
import { redactActivityEntry } from '../shared/domain/redaction';
import {
  type AuthorizationEnvironment,
  authorizationRouteDecisionError,
  type AuthorizationRoute,
  createAuthorizationPolicy,
  createUnauthenticatedPrincipal,
  createTrustedActorResolver,
  resourceScopeAllows,
  type RouteCapabilityDecision,
  type TrustedActorResolver,
  type TrustedPrincipal
} from './authorization';
import {
  MAX_TRACE_SPANS,
  type OperationName,
  OPERATION_NAMES
} from '../shared/operations';
import { isPlainObject } from '../shared/validators';
import { deepClone, SharedStateRepository } from './repository';
import {
  OperationService,
  type OperationHandlerMap,
  type OperationInvocationContext,
  type OperationServiceOptions
} from './operationService';
import {
  StateEventPublisher,
  serializeStateChangedEvent
} from './events';
import {
  resolveActorContext,
  resolveTrustedActorContext,
  type ActorHeaders
} from './actorContext';
import {
  approvalOperationAdapters,
  defaultOperationHandlers
} from './operations';
import {
  createSearchPublicCandidatesHandler,
  type SearchPublicCandidatesAuthorizationOptions
} from './operations/searchPublicCandidates';
import {
  PublicJobsCoordinator,
  type PublicJobsCoordinatorOptions,
  type PublicJobsService
} from './imports/publicJobs';
import {
  GitHubProspectService,
  type GitHubProspectServiceApi,
  type GitHubProspectServiceOptions
} from './prospects';

export type StateProjectionFilter<T> = (
  record: T,
  actor: ActorContext | undefined
) => boolean;

/**
 * Server-side hooks for actor/resource scoping. The serializer always applies
 * its own allowlists; hooks can only decide which already-safe records are
 * visible and cannot replace a projected record with an internal one.
 */
export interface StateProjectionHooks {
  actor?: ActorContext;
  /** Trusted principal used for the built-in resource visibility defaults. */
  principal?: TrustedPrincipal;
  jobFilter?: StateProjectionFilter<JobRequisition>;
  candidateFilter?: StateProjectionFilter<CandidateRecord>;
  applicationFilter?: StateProjectionFilter<ApplicationRecord>;
  panelFilter?: StateProjectionFilter<InterviewPanel>;
  interviewFilter?: StateProjectionFilter<InterviewRecord>;
  scorecardFilter?: StateProjectionFilter<ScorecardRecord>;
  offerFilter?: StateProjectionFilter<OfferRecord>;
  onboardingTaskFilter?: StateProjectionFilter<OnboardingTaskRecord>;
  backgroundCheckFilter?: StateProjectionFilter<BackgroundCheckRecord>;
  benefitsEnrollmentFilter?: StateProjectionFilter<BenefitsEnrollmentRecord>;
  approvalCardFilter?: StateProjectionFilter<ApprovalCardRecord>;
  sourcedProspectFilter?: StateProjectionFilter<SourcedProspectRecord>;
  activityFilter?: StateProjectionFilter<ActivityLogEntry>;
  /** Additive capability-style aliases for embedding hosts. */
  canViewJob?: StateProjectionFilter<JobRequisition>;
  canViewCandidate?: StateProjectionFilter<CandidateRecord>;
  canViewApplication?: StateProjectionFilter<ApplicationRecord>;
  canViewPanel?: StateProjectionFilter<InterviewPanel>;
  canViewInterview?: StateProjectionFilter<InterviewRecord>;
  canViewScorecard?: StateProjectionFilter<ScorecardRecord>;
  canViewOffer?: StateProjectionFilter<OfferRecord>;
  canViewOnboardingTask?: StateProjectionFilter<OnboardingTaskRecord>;
  canViewBackgroundCheck?: StateProjectionFilter<BackgroundCheckRecord>;
  canViewBenefitsEnrollment?: StateProjectionFilter<BenefitsEnrollmentRecord>;
  canViewApprovalCard?: StateProjectionFilter<ApprovalCardRecord>;
  canViewSourcedProspect?: StateProjectionFilter<SourcedProspectRecord>;
  canViewActivity?: StateProjectionFilter<ActivityLogEntry>;
}

export type StateProjectionOptions = StateProjectionHooks;

export interface PipelineApiOptions extends OperationServiceOptions {
  operationService?: OperationService;
  /** Trusted request identity resolver; arbitrary actor headers remain untrusted in production. */
  trustedActorResolver?: TrustedActorResolver;
  /** Environment passed to the trusted resolver and route policy. */
  environment?: AuthorizationEnvironment;
  eventPublisher?: StateEventPublisher;
  /** Inject a live public-job coordinator for tests or embedding hosts. */
  publicJobs?: PublicJobsService;
  publicJobsOptions?: PublicJobsCoordinatorOptions;
  /** Inject the server-only GitHub public-prospect service for tests/hosts. */
  githubProspects?: GitHubProspectServiceApi;
  /** Optional authorization overrides for public-prospect operation actors. */
  githubProspectAuthorization?: SearchPublicCandidatesAuthorizationOptions;
  githubProspectsOptions?: GitHubProspectServiceOptions;
  /**
   * Optional server-side visibility filters for the actor-scoped state
   * projection. The request actor always overrides `hooks.actor`.
   */
  stateProjectionHooks?: Omit<StateProjectionHooks, 'actor'>;
  /** Compatibility spelling for hosts that call these projection options. */
  stateProjection?: Omit<StateProjectionHooks, 'actor'>;
}

export interface PipelineApi {
  app: Express;
  repository: SharedStateRepository;
  operationService: OperationService;
  events: StateEventPublisher;
  publicJobs: PublicJobsService;
  githubProspects: GitHubProspectServiceApi;
}

function mapValues<T>(collection: Map<string, T>): T[] {
  return [...collection.values()].map((value) => deepClone(value));
}

function isActorContext(value: unknown): value is ActorContext {
  return (
    isPlainObject(value) &&
    typeof value.actorType === 'string' &&
    typeof value.actorId === 'string'
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Names that are never allowed across the state serialization boundary. */
function isPrivateProjectionKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, '').toLowerCase();
  return (
    normalized === 'normalizedinput' ||
    normalized === 'rawnormalizedinput' ||
    normalized === 'rawconsentevidence' ||
    normalized === 'consentevidence' ||
    normalized === 'evidencecontents' ||
    normalized === 'rawevidence' ||
    normalized === 'evidence' ||
    normalized === 'scopehash' ||
    normalized.includes('idempotencykey') ||
    normalized.endsWith('fingerprint') ||
    normalized === 'accesstoken' ||
    normalized === 'rawaccesstoken' ||
    normalized === 'authorizationheader'
  );
}

/** Recursively remove private metadata from JSON values without mutation. */
function safeJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value === undefined || typeof value === 'function' ? null : value;
  }
  if (Array.isArray(value)) return value.map((entry) => safeJsonValue(entry));
  if (!isJsonObject(value)) return null;

  const result: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isPrivateProjectionKey(key)) continue;
    result[key] = safeJsonValue(entry) as JsonObject[string];
  }
  return result;
}

function safeJsonObject(value: JsonObject | undefined): JsonObject {
  const projected = safeJsonValue(value ?? {});
  return isJsonObject(projected) ? projected : {};
}

/** Explicit safe projection; internal normalized input/fingerprints are omitted. */
export function projectApprovalCardSummary(
  record: ApprovalCardRecord
): ApprovalCardSummary {
  return {
    id: record.id,
    targetOperation: record.targetOperation,
    requestedBy: {
      actorType: record.requestedBy.actorType,
      actorId: record.requestedBy.actorId
    },
    requestedAt: record.requestedAt,
    baseRevision: record.baseRevision,
    affectedRecords: record.affectedRecords.map((affected) => ({
      type: affected.type,
      id: affected.id,
      effect: affected.effect
    })),
    proposedOutput: safeJsonObject(record.proposedOutput),
    changeSummary: [...record.changeSummary],
    warnings: [...record.warnings],
    ...(record.blockers === undefined ? {} : { blockers: [...record.blockers] }),
    requiredCapability: record.requiredCapability,
    approvalPolicy: record.approvalPolicy,
    ...(record.policyVersion === undefined ? {} : { policyVersion: record.policyVersion }),
    status: record.status,
    ...(record.approvalNote === undefined ? {} : { approvalNote: record.approvalNote }),
    ...(record.rejectionNote === undefined ? {} : { rejectionNote: record.rejectionNote }),
    ...(record.approvedBy === undefined
      ? {}
      : {
          approvedBy: {
            actorType: record.approvedBy.actorType,
            actorId: record.approvedBy.actorId
          }
        }),
    ...(record.approvedAt === undefined ? {} : { approvedAt: record.approvedAt }),
    ...(record.rejectedBy === undefined
      ? {}
      : {
          rejectedBy: {
            actorType: record.rejectedBy.actorType,
            actorId: record.rejectedBy.actorId
          }
        }),
    ...(record.rejectedAt === undefined ? {} : { rejectedAt: record.rejectedAt }),
    expiresAt: record.expiresAt,
    correlationId: record.correlationId,
    traceId: record.traceId,
    ...(record.committedAt === undefined ? {} : { committedAt: record.committedAt }),
    redactions: ['normalizedInput', 'requestFingerprint', 'targetFingerprint']
  };
}

/** Explicit allowlist for provenance; consent evidence remains server-private. */
export function projectSourcedProspect(
  record: SourcedProspectRecord
): SourcedProspectRecord {
  return {
    id: record.id,
    source: record.source,
    sourceRecordId: record.sourceRecordId,
    profileUrl: record.profileUrl,
    canonicalSourceUrl: record.canonicalSourceUrl,
    sourceQuery: record.sourceQuery,
    ...(record.sourceFilters === undefined
      ? {}
      : {
          sourceFilters: {
            ...(record.sourceFilters.language === undefined
              ? {}
              : { language: record.sourceFilters.language }),
            ...(record.sourceFilters.location === undefined
              ? {}
              : { location: record.sourceFilters.location })
          }
        }),
    fetchedAt: record.fetchedAt,
    importedAt: record.importedAt,
    dataOrigin: record.dataOrigin,
    consentStatus: record.consentStatus,
    consent:
      record.consent === null
        ? null
        : {
            method: record.consent.method,
            scope: record.consent.scope,
            capturedAt: record.consent.capturedAt,
            capturedBy: {
              actorType: record.consent.capturedBy.actorType,
              actorId: record.consent.capturedBy.actorId
            },
            evidenceRef: record.consent.evidenceRef,
            policyVersion: record.consent.policyVersion
          },
    fieldOrigins: Object.fromEntries(
      Object.entries(record.fieldOrigins).map(([field, origin]) => [field, origin])
    ) as SourcedProspectRecord['fieldOrigins'],
    attribution: {
      source: record.attribution.source,
      apiUrl: record.attribution.apiUrl,
      searchApiDocsUrl: record.attribution.searchApiDocsUrl,
      rateLimitsDocsUrl: record.attribution.rateLimitsDocsUrl,
      userApiDocsUrl: record.attribution.userApiDocsUrl
    },
    retentionExpiresAt: record.retentionExpiresAt,
    ...(record.withdrawnAt === undefined ? {} : { withdrawnAt: record.withdrawnAt }),
    ...(record.expiredAt === undefined ? {} : { expiredAt: record.expiredAt }),
    ...(record.candidateLinkOrigin === undefined
      ? {}
      : { candidateLinkOrigin: record.candidateLinkOrigin }),
    ...(record.candidateId === undefined ? {} : { candidateId: record.candidateId })
  };
}

function projectTraceSpan(span: TraceSpan): TraceSpan {
  return {
    spanId: span.spanId,
    ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
    name: span.name,
    status: span.status,
    startedAt: span.startedAt,
    ...(span.completedAt === undefined ? {} : { completedAt: span.completedAt }),
    ...(span.durationMs === undefined ? {} : { durationMs: span.durationMs }),
    ...(span.summary === undefined ? {} : { summary: safeJsonObject(span.summary) })
  };
}

function projectActivityEntry(entry: ActivityLogEntry): ActivityLogEntry {
  const safeEntry = redactActivityEntry(entry);
  const projected: ActivityLogEntry = {
    id: safeEntry.id,
    toolName: safeEntry.toolName,
    actorType: safeEntry.actorType,
    actorId: safeEntry.actorId,
    input: safeEntry.input,
    output: safeEntry.output,
    timestamp: safeEntry.timestamp
  };
  if (safeEntry.correlationId !== undefined) projected.correlationId = safeEntry.correlationId;
  if (safeEntry.traceId !== undefined) projected.traceId = safeEntry.traceId;
  if (safeEntry.spanId !== undefined) projected.spanId = safeEntry.spanId;
  if (safeEntry.parentSpanId !== undefined) projected.parentSpanId = safeEntry.parentSpanId;
  if (safeEntry.phase !== undefined) projected.phase = safeEntry.phase;
  if (safeEntry.replayed !== undefined) projected.replayed = safeEntry.replayed;
  if (safeEntry.originalActivityId !== undefined) {
    projected.originalActivityId = safeEntry.originalActivityId;
  }
  if (safeEntry.approvalId !== undefined) projected.approvalId = safeEntry.approvalId;
  if (safeEntry.redactions !== undefined) projected.redactions = [...safeEntry.redactions];
  if (safeEntry.trace !== undefined) {
    const trace: ActivityTrace = {
      spans: safeEntry.trace.spans
        .slice(0, MAX_TRACE_SPANS)
        .map(projectTraceSpan)
    };
    projected.trace = trace;
  }
  return projected;
}

function projectionHooks(
  value: ActorContext | StateProjectionHooks | undefined
): StateProjectionHooks {
  return isActorContext(value) ? { actor: value } : value ?? {};
}

type StateVisibility = {
  job: (record: JobRequisition) => boolean;
  candidate: (record: CandidateRecord) => boolean;
  application: (record: ApplicationRecord) => boolean;
  panel: (record: InterviewPanel) => boolean;
  interview: (record: InterviewRecord) => boolean;
  scorecard: (record: ScorecardRecord) => boolean;
  offer: (record: OfferRecord) => boolean;
  onboardingTask: (record: OnboardingTaskRecord) => boolean;
  backgroundCheck: (record: BackgroundCheckRecord) => boolean;
  benefitsEnrollment: (record: BenefitsEnrollmentRecord) => boolean;
  approvalCard: (record: ApprovalCardRecord) => boolean;
  sourcedProspect: (record: SourcedProspectRecord) => boolean;
  activity: (record: ActivityLogEntry) => boolean;
};

function sameActor(left: ActorContext, right: ActorContext | undefined): boolean {
  return right !== undefined && left.actorType === right.actorType && left.actorId === right.actorId;
}

function resourceVisible(
  principal: TrustedPrincipal,
  resourceType: Parameters<typeof resourceScopeAllows>[1]['resourceType'],
  resourceId?: string,
  subjectId?: string
): boolean {
  return resourceScopeAllows(principal, {
    resourceType,
    ...(resourceId === undefined ? {} : { resourceIds: [resourceId] }),
    ...(subjectId === undefined ? {} : { subjectId })
  });
}

function createStateVisibility(
  state: SharedStateWithCatalogs,
  principal: TrustedPrincipal
): StateVisibility {
  const candidateRole = principal.roles.includes('candidate');

  const canJob = (record: JobRequisition): boolean =>
    (candidateRole && record.status === 'open') ||
    resourceVisible(principal, 'job', record.id);
  const canCandidate = (record: CandidateRecord): boolean =>
    resourceVisible(principal, 'candidate', record.id, record.id);
  const canApplication = (record: ApplicationRecord): boolean => {
    const job = state.jobs.get(record.jobId);
    return (
      resourceVisible(principal, 'application', record.id, record.candidateId) ||
      (job !== undefined && canJob(job))
    );
  };
  const canPanel = (record: InterviewPanel): boolean => {
    if (candidateRole) return false;
    const job = state.jobs.get(record.jobId);
    return resourceVisible(principal, 'panel', record.id) ||
      (job !== undefined && canJob(job));
  };
  const canInterview = (record: InterviewRecord): boolean => {
    const application = state.applications.get(record.applicationId);
    const panel = state.panels.get(record.panelId);
    return resourceVisible(principal, 'interview', record.id) ||
      (application !== undefined && canApplication(application) &&
        (candidateRole || (panel !== undefined && canPanel(panel))));
  };
  const canScorecard = (record: ScorecardRecord): boolean => {
    const interview = state.interviews.get(record.interviewId);
    return !candidateRole &&
      (resourceVisible(principal, 'interview', record.interviewId) ||
        (interview !== undefined && canInterview(interview)));
  };
  const canOffer = (record: OfferRecord): boolean => {
    const application = state.applications.get(record.applicationId);
    const canInheritApplicationVisibility =
      !principal.roles.includes('candidate') &&
      !principal.roles.includes('hiring_manager') &&
      !principal.roles.includes('hiring-manager') &&
      !principal.roles.includes('interviewer');
    return (
      resourceVisible(principal, 'offer', record.id, application?.candidateId) ||
      (canInheritApplicationVisibility &&
        application !== undefined &&
        canApplication(application))
    );
  };
  const canOnboardingTask = (record: OnboardingTaskRecord): boolean => {
    const offer = state.offers.get(record.offerId);
    const application = offer === undefined
      ? undefined
      : state.applications.get(offer.applicationId);
    return (
      resourceVisible(principal, 'onboarding', record.id, application?.candidateId) ||
      (offer !== undefined && canOffer(offer))
    );
  };
  const canBackgroundCheck = (record: BackgroundCheckRecord): boolean => {
    const offer = state.offers.get(record.offerId);
    return offer !== undefined && canOffer(offer);
  };
  const canBenefitsEnrollment = (record: BenefitsEnrollmentRecord): boolean => {
    const offer = state.offers.get(record.offerId);
    return offer !== undefined && canOffer(offer);
  };
  const canSourcedProspect = (record: SourcedProspectRecord): boolean =>
    !candidateRole && resourceVisible(principal, 'prospect', record.id);

  const affectedResourceType = (type: string): Parameters<typeof resourceScopeAllows>[1]['resourceType'] | undefined => {
    const normalized = type.toLowerCase();
    if (normalized.includes('job')) return 'job';
    if (normalized.includes('candidate')) return 'candidate';
    if (normalized.includes('application')) return 'application';
    if (normalized.includes('panel')) return 'panel';
    if (normalized.includes('interview')) return 'interview';
    if (normalized.includes('scorecard')) return 'interview';
    if (normalized.includes('offer')) return 'offer';
    if (normalized.includes('onboarding')) return 'onboarding';
    if (normalized.includes('background')) return 'offer';
    if (normalized.includes('benefit')) return 'offer';
    if (normalized.includes('prospect')) return 'prospect';
    return undefined;
  };

  const canApprovalCard = (record: ApprovalCardRecord): boolean => {
    if (candidateRole) return false;
    if (sameActor(record.requestedBy, principal.actor)) return true;
    if (
      principal.actor.actorType !== 'human_ui' ||
      !principal.authenticated ||
      !principal.trusted ||
      principal.approvalCapabilities.length === 0
    ) return false;

    const normalizedInput = record.normalizedInput;
    if (record.targetOperation === 'coordinate_interview_workflow') {
      const applicationId = normalizedInput.applicationId;
      if (typeof applicationId !== 'string') return false;
      const application = state.applications.get(applicationId);
      return application !== undefined && canApplication(application);
    }
    if (record.targetOperation === 'coordinate_onboarding_workflow') {
      const offerId = normalizedInput.offerId;
      if (typeof offerId !== 'string') return false;
      const offer = state.offers.get(offerId);
      return offer !== undefined && canOffer(offer);
    }
    if (
      record.targetOperation === 'import_public_prospect' ||
      record.targetOperation === 'revoke_public_prospect_consent'
    ) {
      const prospectId = normalizedInput.sourcedProspectId;
      if (typeof prospectId !== 'string') return resourceVisible(principal, 'prospect');
      const prospect = state.sourcedProspects.get(prospectId);
      return prospect !== undefined && canSourcedProspect(prospect);
    }

    return record.affectedRecords.some((affected) => {
      const resourceType = affectedResourceType(affected.type);
      return resourceType !== undefined && resourceVisible(principal, resourceType, affected.id);
    });
  };

  type ResourceReference = {
    type: Parameters<typeof resourceScopeAllows>[1]['resourceType'];
    id: string;
  };
  const fieldTypes: Record<string, ResourceReference['type']> = {
    jobId: 'job',
    candidateId: 'candidate',
    applicationId: 'application',
    panelId: 'panel',
    interviewId: 'interview',
    offerId: 'offer',
    taskId: 'onboarding',
    sourcedProspectId: 'prospect',
    approvalId: 'approval'
  };

  const collectReferences = (
    value: unknown,
    result: ResourceReference[] = [],
    depth = 0
  ): ResourceReference[] => {
    if (depth > 4 || value === null || typeof value !== 'object') return result;
    if (Array.isArray(value)) {
      for (const entry of value.slice(0, 50)) collectReferences(entry, result, depth + 1);
      return result;
    }
    for (const [key, child] of Object.entries(value)) {
      const type = fieldTypes[key];
      if (type !== undefined && typeof child === 'string' && child.length > 0) {
        result.push({ type, id: child });
      }
      collectReferences(child, result, depth + 1);
    }
    return result;
  };

  const resourceReferenceVisible = (reference: ResourceReference): boolean => {
    if (reference.type === 'approval') {
      const approval = state.approvalCards.get(reference.id);
      return approval !== undefined && canApprovalCard(approval);
    }
    if (reference.type === 'job') {
      const job = state.jobs.get(reference.id);
      return job !== undefined && canJob(job);
    }
    if (reference.type === 'candidate') {
      const candidate = state.candidates.get(reference.id);
      return candidate !== undefined && canCandidate(candidate);
    }
    if (reference.type === 'application') {
      const application = state.applications.get(reference.id);
      return application !== undefined && canApplication(application);
    }
    if (reference.type === 'panel') {
      const panel = state.panels.get(reference.id);
      return panel !== undefined && canPanel(panel);
    }
    if (reference.type === 'interview') {
      const interview = state.interviews.get(reference.id);
      return interview !== undefined && canInterview(interview);
    }
    if (reference.type === 'offer') {
      const offer = state.offers.get(reference.id);
      return offer !== undefined && canOffer(offer);
    }
    if (reference.type === 'onboarding') {
      const task = state.onboardingTasks.get(reference.id);
      return task !== undefined && canOnboardingTask(task);
    }
    if (reference.type === 'prospect') {
      const prospect = state.sourcedProspects.get(reference.id);
      return prospect !== undefined && canSourcedProspect(prospect);
    }
    return false;
  };

  const canActivity = (record: ActivityLogEntry): boolean => {
    if (sameActor(record, principal.actor)) return true;
    const references = collectReferences(record.input).concat(collectReferences(record.output));
    if (references.length === 0) return false;
    return references.some(resourceReferenceVisible);
  };

  return {
    job: canJob,
    candidate: canCandidate,
    application: canApplication,
    panel: canPanel,
    interview: canInterview,
    scorecard: canScorecard,
    offer: canOffer,
    onboardingTask: canOnboardingTask,
    backgroundCheck: canBackgroundCheck,
    benefitsEnrollment: canBenefitsEnrollment,
    approvalCard: canApprovalCard,
    sourcedProspect: canSourcedProspect,
    activity: canActivity
  };
}

function combineProjectionFilter<T>(
  builtIn: ((record: T) => boolean) | undefined,
  custom: StateProjectionFilter<T> | undefined,
  actor: ActorContext | undefined
): ((record: T) => boolean) | undefined {
  if (builtIn === undefined && custom === undefined) return undefined;
  return (record) =>
    (builtIn?.(record) ?? true) && (custom?.(record, actor) ?? true);
}

/**
 * Convert the map-backed repository snapshot to the stable JSON state shape.
 * With a trusted principal, relationship-aware defaults scope every collection;
 * the old actor-less overload remains an intentionally unscoped compatibility
 * projection for local/demo callers that have not installed authorization.
 */
export function serializeSharedState(
  state: SharedStateWithCatalogs,
  actor?: ActorContext
): SharedStateProjectionWithCatalogs;
export function serializeSharedState(
  state: SharedStateWithCatalogs,
  hooks?: StateProjectionHooks
): SharedStateProjectionWithCatalogs;
export function serializeSharedState(
  state: SharedStateWithCatalogs,
  actorOrHooks?: ActorContext | StateProjectionHooks
): SharedStateProjectionWithCatalogs {
  const hooks = projectionHooks(actorOrHooks);
  const actor = hooks.actor;
  const visibility = hooks.principal === undefined
    ? undefined
    : createStateVisibility(state, hooks.principal);
  const filters = {
    job: combineProjectionFilter(visibility?.job, hooks.jobFilter ?? hooks.canViewJob, actor),
    candidate: combineProjectionFilter(visibility?.candidate, hooks.candidateFilter ?? hooks.canViewCandidate, actor),
    application: combineProjectionFilter(visibility?.application, hooks.applicationFilter ?? hooks.canViewApplication, actor),
    panel: combineProjectionFilter(visibility?.panel, hooks.panelFilter ?? hooks.canViewPanel, actor),
    interview: combineProjectionFilter(visibility?.interview, hooks.interviewFilter ?? hooks.canViewInterview, actor),
    scorecard: combineProjectionFilter(visibility?.scorecard, hooks.scorecardFilter ?? hooks.canViewScorecard, actor),
    offer: combineProjectionFilter(visibility?.offer, hooks.offerFilter ?? hooks.canViewOffer, actor),
    onboardingTask: combineProjectionFilter(visibility?.onboardingTask, hooks.onboardingTaskFilter ?? hooks.canViewOnboardingTask, actor),
    backgroundCheck: combineProjectionFilter(visibility?.backgroundCheck, hooks.backgroundCheckFilter ?? hooks.canViewBackgroundCheck, actor),
    benefitsEnrollment: combineProjectionFilter(visibility?.benefitsEnrollment, hooks.benefitsEnrollmentFilter ?? hooks.canViewBenefitsEnrollment, actor),
    approvalCard: combineProjectionFilter(visibility?.approvalCard, hooks.approvalCardFilter ?? hooks.canViewApprovalCard, actor),
    sourcedProspect: combineProjectionFilter(visibility?.sourcedProspect, hooks.sourcedProspectFilter ?? hooks.canViewSourcedProspect, actor),
    activity: combineProjectionFilter(visibility?.activity, hooks.activityFilter ?? hooks.canViewActivity, actor)
  };
  const approvalCards = state.approvalCards ?? new Map<string, ApprovalCardRecord>();
  const sourcedProspects = state.sourcedProspects ?? new Map<string, SourcedProspectRecord>();
  const visible = <T>(values: readonly T[], filter: ((record: T) => boolean) | undefined): T[] =>
    filter === undefined ? [...values] : values.filter(filter);
  const panels = visible(mapValues(state.panels), filters.panel);
  const visiblePanelInterviewerIds = new Set(
    panels.flatMap((panel) => panel.interviewers.map((interviewer) => interviewer.id))
  );

  return {
    revision: state.revision,
    jobs: visible(mapValues(state.jobs), filters.job),
    candidates: visible(mapValues(state.candidates), filters.candidate),
    applications: visible(mapValues(state.applications), filters.application),
    panels,
    interviews: visible(mapValues(state.interviews), filters.interview),
    scorecards: visible(mapValues(state.scorecards), filters.scorecard),
    offers: visible(mapValues(state.offers), filters.offer),
    onboardingTasks: visible(mapValues(state.onboardingTasks), filters.onboardingTask),
    backgroundChecks: visible(mapValues(state.backgroundChecks), filters.backgroundCheck),
    benefitsEnrollments: visible(mapValues(state.benefitsEnrollments), filters.benefitsEnrollment),
    approvalCards: visible([...approvalCards.values()], filters.approvalCard).map(projectApprovalCardSummary),
    sourcedProspects: visible([...sourcedProspects.values()], filters.sourcedProspect).map(projectSourcedProspect),
    activityLog: visible(state.activityLog, filters.activity).map(projectActivityEntry),
    catalogs: {
      availabilityCalendar: [...state.catalogs.availabilityCalendar.entries()]
        .filter(([interviewerId]) => visibility === undefined || visiblePanelInterviewerIds.has(interviewerId))
        .map(([interviewerId, freeSlots]) => ({ interviewerId, freeSlots: deepClone(freeSlots) })),
      roleTemplates: deepClone(state.catalogs.roleTemplates),
      planCatalog: deepClone(state.catalogs.planCatalog),
      startDate: state.catalogs.startDate
    }
  };
}

type RequestHeaderValue = string | string[] | undefined;

type OperationResponseContext = {
  service: OperationService;
  activityStart: number;
  operationName: string;
  actor?: ActorContext;
  correlationHint?: string;
};

function headerValue(request: Request, name: string): RequestHeaderValue {
  const normalizedName = name.toLowerCase();
  const headers = request.headers as Record<string, RequestHeaderValue>;
  const direct = headers[normalizedName];
  if (direct !== undefined) return direct;
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === normalizedName
  );
  return key === undefined ? undefined : headers[key];
}

function headerString(request: Request, name: string): string | undefined {
  const value = headerValue(request, name);
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new ValidationError(`Header ${name} must contain one value`, {
        field: `header.${name}`,
        reason: 'metadata_invalid'
      });
    }
    return value[0];
  }
  return value;
}

function metadataValidation(error: unknown): never {
  const pipelineError = PipelineError.from(error);
  if (pipelineError.code === 'VALIDATION_ERROR') {
    throw new ValidationError(pipelineError.message, {
      ...(pipelineError.details ?? {}),
      reason: 'metadata_invalid'
    });
  }
  throw error;
}

function parseRevisionHeader(
  value: string | undefined,
  field: string,
  allowPrefix: boolean
): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  const match = allowPrefix
    ? /^revision-(\d+)$/u.exec(normalized)
    : /^(?:revision-)?(\d+)$/u.exec(normalized);
  if (match === null) {
    throw new ValidationError(`${field} must be a non-negative revision`, {
      field: `header.${field}`,
      reason: 'metadata_invalid'
    });
  }
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision)) {
    throw new ValidationError(`${field} must be a safe integer`, {
      field: `header.${field}`,
      reason: 'metadata_invalid'
    });
  }
  return revision;
}

function normalizeTransportMetadata(value: unknown): InvocationMetadata | undefined {
  try {
    return normalizeInvocationMetadata(value);
  } catch (error) {
    return metadataValidation(error);
  }
}

/** Read body metadata and equivalent transport headers without touching input. */
function requestInvocationMetadata(request: Request): InvocationMetadata | undefined {
  const body = isPlainObject(request.body) ? request.body : undefined;
  const bodyMetadata = normalizeTransportMetadata(
    body !== undefined && Object.prototype.hasOwnProperty.call(body, 'metadata')
      ? body.metadata
      : undefined
  );

  const correlationId = headerString(request, 'x-correlation-id');
  const idempotencyKey = headerString(request, 'idempotency-key');
  const approvalId = headerString(request, 'x-approval-id');
  const parentSpanId = headerString(request, 'x-parent-span-id');
  const ifMatch = parseRevisionHeader(
    headerString(request, 'if-match'),
    'If-Match',
    true
  );
  const expectedRevision = parseRevisionHeader(
    headerString(request, 'x-expected-revision'),
    'X-Expected-Revision',
    false
  );
  if (
    ifMatch !== undefined &&
    expectedRevision !== undefined &&
    ifMatch !== expectedRevision
  ) {
    throw new ValidationError('Revision headers must agree', {
      field: 'metadata.expectedRevision',
      reason: 'metadata_invalid'
    });
  }

  const headerMetadata = normalizeTransportMetadata({
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...((ifMatch ?? expectedRevision) === undefined
      ? {}
      : { expectedRevision: ifMatch ?? expectedRevision }),
    ...(approvalId === undefined ? {} : { approvalId }),
    ...(parentSpanId === undefined ? {} : { parentSpanId })
  });

  if (bodyMetadata === undefined && headerMetadata === undefined) return undefined;
  const merged: InvocationMetadata = { ...(bodyMetadata ?? {}) };
  for (const field of [
    'correlationId',
    'idempotencyKey',
    'expectedRevision',
    'approvalId',
    'parentSpanId'
  ] as const) {
    const bodyValue = bodyMetadata?.[field];
    const headerValueForField = headerMetadata?.[field];
    if (
      bodyValue !== undefined &&
      headerValueForField !== undefined &&
      bodyValue !== headerValueForField
    ) {
      throw new ValidationError(`Body and header metadata differ for ${field}`, {
        field: `metadata.${field}`,
        reason: 'metadata_invalid'
      });
    }
    if (headerValueForField !== undefined) {
      Object.assign(merged, { [field]: headerValueForField });
    }
  }
  return merged;
}

function correlationHint(request: Request): string | undefined {
  const header = headerString(request, 'x-correlation-id');
  if (header !== undefined && header.trim().length > 0) return header.trim();
  const body = isPlainObject(request.body) ? request.body : undefined;
  const metadata = body?.metadata;
  return isPlainObject(metadata) && typeof metadata.correlationId === 'string'
    ? metadata.correlationId.trim() || undefined
    : undefined;
}

function fallbackCorrelationId(): string {
  return `correlation-${randomUUID()}`;
}

function responseActivity(
  context: OperationResponseContext
): ActivityLogEntry | undefined {
  const entries = context.service.repository.read().activityLog;
  return entries
    .slice(context.activityStart)
    .reverse()
    .find(
      (entry) =>
        entry.toolName === context.operationName &&
        (context.actor === undefined ||
          (entry.actorType === context.actor.actorType &&
            entry.actorId === context.actor.actorId))
    );
}

function setOperationResponseHeaders(context: OperationResponseContext, response: Response): void {
  const activity = responseActivity(context);
  response.setHeader(
    'X-Correlation-Id',
    activity?.correlationId ?? context.correlationHint ?? fallbackCorrelationId()
  );
  if (activity?.traceId !== undefined) {
    response.setHeader('X-Trace-Id', activity.traceId);
  }
  if (activity?.spanId !== undefined) {
    response.setHeader('X-Span-Id', activity.spanId);
  }
  if (activity?.parentSpanId !== undefined) {
    response.setHeader('X-Parent-Span-Id', activity.parentSpanId);
  }
  if (activity?.replayed === true) {
    response.setHeader('X-Idempotency-Replayed', 'true');
    if (activity.originalActivityId !== undefined) {
      response.setHeader(
        'X-Idempotency-Original-Activity-Id',
        activity.originalActivityId
      );
    }
  }
}

function sendError(
  response: Response,
  error: unknown,
  context?: OperationResponseContext
): void {
  const pipelineError = PipelineError.from(error);
  if (!response.headersSent) {
    if (context !== undefined) setOperationResponseHeaders(context, response);
    response.status(pipelineError.status).json(pipelineError.toPayload());
  }
}

function requestBodyInput(request: Request): unknown {
  if (isPlainObject(request.body) && 'input' in request.body) {
    return request.body.input;
  }
  // The canonical endpoint requires `{ input: ... }`; undefined is passed to
  // the shared validator so the invocation still receives one audit entry.
  return undefined;
}

function bodyWithoutTransportMetadata(request: Request): Record<string, unknown> {
  const body = isPlainObject(request.body) ? request.body : {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key !== 'metadata') result[key] = value;
  }
  return result;
}

function stripTransportMetadata(value: unknown): unknown {
  if (!isPlainObject(value) || !Object.prototype.hasOwnProperty.call(value, 'metadata')) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key !== 'metadata') result[key] = entry;
  }
  return result;
}

function bodyOrEmpty(request: Request): Record<string, unknown> {
  return isPlainObject(request.body) ? request.body : {};
}

const GITHUB_PROSPECT_QUERY_FIELDS = new Set(['query', 'language', 'location']);

/**
 * Translate the compatibility query into operation input without invoking the
 * GitHub service here. Allowed query values retain their original types so the
 * shared operation validator can audit malformed/repeated values as 400s.
 * An unsupported-field marker deliberately remains invalid input, preserving
 * the operation audit path without forwarding that field to GitHub.
 */
function githubProspectSearchInput(request: Request): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const field of GITHUB_PROSPECT_QUERY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(request.query, field)) {
      input[field] = request.query[field];
    }
  }

  const unknownField = Object.keys(request.query).find(
    (field) => !GITHUB_PROSPECT_QUERY_FIELDS.has(field)
  );
  if (unknownField !== undefined) {
    input.__unsupportedQueryParameter = unknownField;
  }

  return input;
}

function environmentPositiveInteger(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function legacyOfferDecision(value: unknown): unknown {
  if (value === 'accepted') return 'accept';
  if (value === 'declined') return 'decline';
  if (value === 'countered') return 'counter';
  return value;
}

type RequestIdentity = {
  actor: ActorContext;
  principal?: TrustedPrincipal;
};

function queryString(request: Request, name: string): string | undefined {
  const value = request.query[name];
  if (Array.isArray(value)) return value.length === 1 ? String(value[0]) : undefined;
  return typeof value === 'string' ? value : undefined;
}

function trustedActorHeaders(request: Request, environment?: AuthorizationEnvironment): ActorHeaders {
  const headers = { ...(request.headers as ActorHeaders) };
  if (environment === 'production') return headers;
  const hasType = headerValue(request, 'x-actor-type') !== undefined;
  const hasId = headerValue(request, 'x-actor-id') !== undefined;
  // Native EventSource cannot set headers. Query values are accepted only as
  // non-production presentation metadata; the trusted resolver still limits
  // them to known demo identities and production ignores them entirely.
  if (!hasType) {
    const actorType = queryString(request, 'actorType');
    if (actorType !== undefined) headers['x-actor-type'] = actorType;
  }
  if (!hasId) {
    const actorId = queryString(request, 'actorId');
    if (actorId !== undefined) headers['x-actor-id'] = actorId;
  }
  return headers;
}

async function resolveRequestIdentity(
  request: Request,
  options: PipelineApiOptions
): Promise<RequestIdentity> {
  if (options.trustedActorResolver !== undefined) {
    const principal = await resolveTrustedActorContext(
      request,
      options.trustedActorResolver,
      {
        environment: options.environment,
        headers: trustedActorHeaders(request, options.environment)
      }
    );
    return { actor: principal.actor, principal };
  }

  const configuredPrincipal = options.principal ?? options.trustedPrincipal;
  if (configuredPrincipal !== undefined) {
    return { actor: configuredPrincipal.actor, principal: configuredPrincipal };
  }
  return { actor: resolveActorContext(request) };
}

function routeFallbackDecision(
  route: AuthorizationRoute,
  principal: TrustedPrincipal,
  environment: AuthorizationEnvironment
): RouteCapabilityDecision {
  const requiredCapability =
    route === 'state' ? 'state.read' : route === 'events' ? 'state.events' : 'state.reset';
  const authenticated =
    principal.authenticationStatus === 'authenticated' &&
    principal.authenticated &&
    principal.trusted &&
    !(environment === 'production' && principal.source === 'demo');
  const allowed =
    authenticated &&
    (route !== 'reset' ||
      principal.roles.includes('recruiter') ||
      principal.roles.includes('admin') ||
      principal.roles.includes('system'));
  return {
    allowed,
    authenticated,
    route,
    requiredCapability,
    ...(allowed
      ? {}
      : {
          denialReason: authenticated
            ? ('capability_denied' as const)
            : ('not_authenticated' as const)
        }),
    environment,
    policyVersion: principal.policyVersion
  };
}

async function authorizeRouteAccess(
  route: AuthorizationRoute,
  identity: RequestIdentity,
  options: PipelineApiOptions
): Promise<void> {
  if (options.authorizationPolicy === undefined && options.trustedActorResolver === undefined) {
    return;
  }
  const principal = identity.principal ?? createUnauthenticatedPrincipal();
  if (options.authorizationPolicy?.decideRoute !== undefined) {
    const decision = await options.authorizationPolicy.decideRoute({
      principal,
      route,
      environment: options.environment
    });
    if (!decision.allowed) throw authorizationRouteDecisionError(decision);
    return;
  }
  const decision = routeFallbackDecision(
    route,
    principal,
    options.environment ?? 'development'
  );
  if (!decision.allowed) throw authorizationRouteDecisionError(decision);
}

function safeCorrelationHint(request: Request): string | undefined {
  try {
    const correlationId = correlationHint(request);
    if (correlationId === undefined) return undefined;
    return normalizeInvocationMetadata({ correlationId })?.correlationId;
  } catch {
    // Invalid or overlong transport metadata must never prevent the server
    // from returning its structured validation envelope.
    return undefined;
  }
}

function setRouteCorrelationHeader(
  request: Request,
  response: Response,
  correlationId?: string
): void {
  response.setHeader(
    'X-Correlation-Id',
    correlationId ?? safeCorrelationHint(request) ?? fallbackCorrelationId()
  );
}

async function invokeHttpOperation(
  service: OperationService,
  name: OperationName | string,
  input: unknown,
  request: Request,
  response: Response,
  next: NextFunction,
  options: PipelineApiOptions
): Promise<void> {
  const activityStart = service.repository.read().activityLog.length;
  let identity: RequestIdentity | undefined;
  const responseContext = (): OperationResponseContext => ({
    service,
    activityStart,
    operationName: String(name),
    ...(identity === undefined ? {} : { actor: identity.actor }),
    correlationHint: safeCorrelationHint(request)
  });

  try {
    identity = await resolveRequestIdentity(request, options);
    const metadata = requestInvocationMetadata(request);
    const invocation = {
      name: name as OperationName,
      input: input as never,
      actor: identity.actor,
      ...(metadata === undefined ? {} : { metadata })
    };
    const context: OperationInvocationContext | undefined =
      identity.principal === undefined && options.environment === undefined
        ? undefined
        : {
            ...(identity.principal === undefined
              ? {}
              : { principal: identity.principal }),
            ...(options.environment === undefined
              ? {}
              : { environment: options.environment })
          };
    const output = await service.invoke(invocation, context);
    setOperationResponseHeaders(responseContext(), response);
    response.json(output);
  } catch (error) {
    if (response.headersSent) {
      next(error);
    } else {
      sendError(response, error, responseContext());
    }
  }
}

function createOperationRoute(
  service: OperationService,
  name: OperationName | string,
  input: (request: Request) => unknown,
  options: PipelineApiOptions
) {
  return async (request: Request, response: Response, next: NextFunction) => {
    // Compatibility adapters may receive a legacy raw body. Strip only that
    // adapter-level transport field; canonical `{ input }` payloads are kept
    // intact so an operation-specific `input.metadata` field is not lost.
    const translatedInput = stripTransportMetadata(input(request));
    await invokeHttpOperation(
      service,
      name,
      translatedInput,
      request,
      response,
      next,
      options
    );
  };
}

function installCompatibilityRoutes(
  app: Express,
  service: OperationService,
  options: PipelineApiOptions = {}
): void {
  const operationRoute = (
    name: OperationName | string,
    input: (request: Request) => unknown
  ) => createOperationRoute(service, name, input, options);

  // Phase A aliases.
  app.post(
    '/api/jobs',
    operationRoute( 'create_job_requisition', (request) => request.body)
  );
  app.post(
    '/api/candidates/search',
    operationRoute( 'search_candidates', (request) => request.body)
  );
  app.get(
    '/api/candidates/:id',
    operationRoute( 'get_candidate_profile', (request) => ({
      candidateId: request.params.id
    }))
  );
  app.post(
    '/api/applications',
    operationRoute( 'submit_application', (request) => request.body)
  );
  app.post(
    '/api/applications/:id/screen',
    operationRoute( 'screen_candidate', (request) => ({
      applicationId: request.params.id
    }))
  );
  app.post(
    '/api/jobs/:id/faq',
    operationRoute( 'answer_candidate_faq', (request) => ({
      jobId: request.params.id,
      question: bodyOrEmpty(request).question
    }))
  );

  // Phase B aliases.
  app.post(
    '/api/interviews/availability',
    operationRoute( 'check_interviewer_availability', (request) =>
      request.body
    )
  );
  app.post(
    '/api/interviews/propose',
    operationRoute( 'propose_interview_slots', (request) => request.body)
  );
  app.post(
    '/api/interviews/book',
    operationRoute( 'book_interview', (request) => request.body)
  );
  app.post(
    '/api/interviews/schedule',
    operationRoute( 'book_interview', (request) => request.body)
  );
  app.get(
    '/api/jobs/:id/interview-kit',
    operationRoute( 'get_interview_kit', (request) => ({
      jobId: request.params.id
    }))
  );
  app.post(
    '/api/interviews/:id/feedback',
    operationRoute( 'submit_interview_feedback', (request) => {
      const body = bodyOrEmpty(request);
      return {
        interviewId: request.params.id,
        interviewer: body.interviewer,
        competencyScores: body.competencyScores,
        recommendation: body.recommendation,
        comments: body.comments
      };
    })
  );
  app.get(
    '/api/applications/:id/feedback-summary',
    operationRoute( 'get_panel_feedback_summary', (request) => ({
      applicationId: request.params.id
    }))
  );

  // Phase C aliases. These adapters only translate paths and legacy decision
  // spellings; all validation and mutation remains in OperationService.
  app.post(
    '/api/offers',
    operationRoute( 'generate_offer', (request) => request.body)
  );
  app.post(
    '/api/offers/:id/send',
    operationRoute( 'send_offer', (request) => ({
      offerId: request.params.id
    }))
  );
  app.post(
    '/api/offers/:id/respond',
    operationRoute( 'respond_to_offer', (request) => {
      const body = bodyOrEmpty(request);
      const decision = legacyOfferDecision(body.decision);
      return {
        offerId: request.params.id,
        decision,
        ...(body.counterAmount !== undefined
          ? { counterAmount: body.counterAmount }
          : {})
      };
    })
  );
  app.post(
    '/api/offers/:id/background-check',
    operationRoute( 'initiate_background_check', (request) => ({
      offerId: request.params.id
    }))
  );
  app.post(
    '/api/offers/:id/benefits',
    operationRoute( 'enroll_benefits', (request) => {
      const body = bodyWithoutTransportMetadata(request);
      return {
        offerId: request.params.id,
        planSelections: body.planSelections ?? body
      };
    })
  );
  app.post(
    '/api/offers/:id/onboarding',
    operationRoute( 'generate_onboarding_checklist', (request) => ({
      offerId: request.params.id
    }))
  );
  app.get(
    '/api/offers/:id/onboarding',
    operationRoute( 'get_onboarding_status', (request) => ({
      offerId: request.params.id
    }))
  );
}

/** Create the API plus its dependencies for tests or a composition root. */
export function createPipelineApi(options: PipelineApiOptions = {}): PipelineApi {
  // Direct API consumers may bypass server.ts, so production must still
  // install the same fail-closed trust boundary instead of falling back to
  // legacy x-actor-* parsing. Explicit trusted resolvers or static principals
  // remain available to embedding hosts.
  const environment =
    options.environment ??
    (process.env.NODE_ENV === 'production' ? 'production' : undefined);
  if (environment === 'production') {
    const productionResolver =
      options.trustedActorResolver ??
      (options.principal === undefined && options.trustedPrincipal === undefined
        ? createTrustedActorResolver({ environment })
        : undefined);
    options = {
      ...options,
      environment,
      authorizationPolicy:
        options.authorizationPolicy ?? createAuthorizationPolicy({ environment }),
      ...(productionResolver === undefined
        ? {}
        : { trustedActorResolver: productionResolver })
    };
  }

  // Construct/inject the server-only service before composing the operation
  // dispatcher. The token is read only at this server boundary and never
  // becomes part of operation input, output, activity, or serialized state.
  const githubProspects =
    options.githubProspects ??
    new GitHubProspectService({
      ...options.githubProspectsOptions,
      token:
        options.githubProspectsOptions?.token ?? process.env.GITHUB_TOKEN,
      maxResults:
        options.githubProspectsOptions?.maxResults ??
        environmentPositiveInteger('GITHUB_PROSPECT_MAX_RESULTS'),
      cacheTtlMs:
        options.githubProspectsOptions?.cacheTtlMs ??
        environmentPositiveInteger('GITHUB_PROSPECT_CACHE_TTL_MS')
    });
  const publicProspectHandler = createSearchPublicCandidatesHandler(
    githubProspects,
    options.githubProspectAuthorization
  );
  const operationService =
    options.operationService ??
    new OperationService({
      repository: options.repository ?? new SharedStateRepository(),
      handlers: {
        ...defaultOperationHandlers,
        search_public_candidates: publicProspectHandler,
        ...(options.handlers ?? {})
      },
      orchestrationAdapters: approvalOperationAdapters,
      authorizationPolicy: options.authorizationPolicy,
      principal: options.principal,
      trustedPrincipal: options.trustedPrincipal,
      principalResolver: options.principalResolver,
      resolvePrincipal: options.resolvePrincipal,
      environment: options.environment,
      idempotencyTtlMs: options.idempotencyTtlMs,
      approvalTtlMs: options.approvalTtlMs,
      traceIdentifiers: options.traceIdentifiers
    });

  if (options.operationService) {
    operationService.registerOrchestrationAdapters(approvalOperationAdapters);
    operationService.registerHandlers(options.handlers ?? {});
    // An externally composed service may have been created with the static
    // default map, so bind the injected dependency unless the caller supplied
    // an explicit public-prospect handler override.
    if (options.handlers?.search_public_candidates === undefined) {
      operationService.registerHandler(
        'search_public_candidates',
        publicProspectHandler
      );
    }
  }

  const repository = operationService.repository;
  const stateProjectionHooks =
    options.stateProjectionHooks ?? options.stateProjection ?? {};
  const events =
    options.eventPublisher ?? new StateEventPublisher(repository);
  const publicJobs =
    options.publicJobs ?? new PublicJobsCoordinator(options.publicJobsOptions);
  const app = express();

  // Install eligibility headers before API routes and before server.ts mounts
  // Vite or production static middleware, so every HTML response inherits the
  // same explicit, same-origin WebMCP policy.
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Origin-Agent-Cluster', '?1');
    response.setHeader('Permissions-Policy', 'tools=(self)');
    next();
  });

  app.use(express.json());

  const canonicalRoute = async (
    request: Request,
    response: Response,
    next: NextFunction
  ) => {
    await invokeHttpOperation(
      operationService,
      request.params.operationName,
      requestBodyInput(request),
      request,
      response,
      next,
      options
    );
  };

  app.post('/api/operations/:operationName', canonicalRoute);

  app.get('/api/public-jobs', async (request, response, next) => {
    try {
      const result = await publicJobs.getListings({
        refresh: request.query.refresh === 'true'
      });
      response.json(result);
    } catch (error) {
      if (response.headersSent) next(error);
      else sendError(response, error);
    }
  });

  app.get(
    '/api/prospects/github',
    createOperationRoute(
      operationService,
      'search_public_candidates',
      githubProspectSearchInput,
      options
    )
  );

  app.get('/api/state', async (request, response, next) => {
    try {
      const identity = await resolveRequestIdentity(request, options);
      await authorizeRouteAccess('state', identity, options);
      response.json(
        serializeSharedState(repository.read(), {
          ...stateProjectionHooks,
          actor: identity.actor,
          ...(identity.principal === undefined
            ? {}
            : { principal: identity.principal })
        })
      );
    } catch (error) {
      if (response.headersSent) next(error);
      else sendError(response, error);
    }
  });

  app.post('/api/reset', async (request, response, next) => {
    let correlationId: string | undefined;
    try {
      const identity = await resolveRequestIdentity(request, options);
      await authorizeRouteAccess('reset', identity, options);
      const metadata = requestInvocationMetadata(request);
      correlationId = metadata?.correlationId;
      if (
        metadata?.expectedRevision !== undefined &&
        metadata.expectedRevision !== repository.getRevision()
      ) {
        throw new ConflictError('The reset request was based on a stale revision', {
          reason: 'stale_revision',
          expectedRevision: metadata.expectedRevision,
          currentRevision: repository.getRevision()
        });
      }
      const snapshot = repository.reset();
      setRouteCorrelationHeader(request, response, correlationId);
      response.json({ success: true, revision: snapshot.revision });
    } catch (error) {
      if (response.headersSent) next(error);
      else {
        setRouteCorrelationHeader(request, response, correlationId);
        sendError(response, error);
      }
    }
  });

  app.get('/api/events', async (request, response, next) => {
    try {
      const identity = await resolveRequestIdentity(request, options);
      await authorizeRouteAccess('events', identity, options);
      response.status(200);
      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-cache');
      response.setHeader('Connection', 'keep-alive');
      response.flushHeaders?.();

      let closed = false;
      const unsubscribe = events.subscribe((event) => {
        if (!closed && !response.writableEnded) {
          response.write(serializeStateChangedEvent(event));
        }
      });

      // Send only the current revision as the initial synchronization hint.
      response.write(
        serializeStateChangedEvent({
          type: 'state_changed',
          revision: repository.getRevision()
        })
      );

      const cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
      };
      request.on('close', cleanup);
      response.on('close', cleanup);
    } catch (error) {
      if (response.headersSent) next(error);
      else sendError(response, error);
    }
  });

  installCompatibilityRoutes(app, operationService, options);

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (
      isPlainObject(error) &&
      error.type === 'entity.parse.failed'
    ) {
      sendError(response, new ValidationError('Invalid JSON request body'));
      return;
    }
    sendError(response, error);
  });

  return {
    app,
    repository,
    operationService,
    events,
    publicJobs,
    githubProspects
  };
}

/** Return only the Express app for conventional HTTP test/server usage. */
export function createApi(options: PipelineApiOptions = {}): Express {
  return createPipelineApi(options).app;
}

export const createExpressApi = createApi;
export const createApplicationApi = createPipelineApi;
export const CANONICAL_OPERATION_NAMES = OPERATION_NAMES;

// Keep the map type visible to callers that build a composition root here.
export type { OperationHandlerMap };
