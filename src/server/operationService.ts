/**
 * The single server-side execution boundary for PipelineOS operations.
 *
 * Operation handlers receive only an isolated state snapshot/draft and safe,
 * injected execution context. They never receive the repository, transport,
 * client store, or WebMCP runtime. The additive envelope path owns metadata,
 * authorization, idempotency, revision, approval, and trace orchestration;
 * the legacy three-argument path remains compatible with existing callers.
 */

import { createHash, randomUUID } from 'node:crypto';
import type {
  ActivityLogEntry,
  ActivityPhase,
  ActorContext,
  ApprovalCardRecord,
  ApprovalCardSummary,
  ApprovalCardPolicy,
  ApprovalId,
  GeneratedIdPlaceholder,
  InvocationMetadata,
  JsonObject,
  SharedStateWithCatalogs,
  Timestamp
} from '../shared/models';
import type {
  OperationInput,
  OperationInputMap,
  OperationInvocation,
  OperationName,
  OperationOutput,
  OperationOutputMap,
  PlanOperationInput,
  PlanOperationOutput
} from '../shared/operations';
import {
  getOperationDescriptor,
  PLANABLE_OPERATION_NAMES
} from '../shared/operations';
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  PipelineError,
  type PipelineErrorPayload,
  serializePipelineErrorObject,
  ValidationError
} from '../shared/errors';
import {
  canonicalJsonString,
  canonicalizeJsonObject,
  normalizeInvocationMetadata
} from '../shared/domain/invocationMetadata';
import {
  redactActivityEntry,
  redactJsonObjectWithMetadata
} from '../shared/domain/redaction';
import {
  assertActorContext,
  assertOperationName,
  isPlainObject,
  validateOperationInput,
  validateOperationOutput
} from '../shared/validators';
import {
  authorizationDecisionError,
  createUnauthenticatedPrincipal,
  type AuthorizationEnvironment,
  type AuthorizationMode,
  type AuthorizationPolicy,
  type ConsentContext,
  type ResourceScopeRequirement,
  type TrustedPrincipal
} from './authorization';
import {
  cloneLedgerJson,
  createInvocationRequestFingerprint,
  createInvocationScopeHash,
  expiryTimestamp,
  getLiveInvocationLedgerEntry,
  type InvocationScopeInput
} from './invocationLedger';
import {
  deepClone,
  SharedStateRepository,
  type Clock,
  type IdGenerator,
  type InvocationLedgerEntry
} from './repository';
import {
  createOperationTrace,
  type OperationTraceContext,
  type TraceIdentifierFactory
} from './trace';

/**
 * Context supplied to an operation implementation. `state` is always an
 * isolated object: for a mutation it is the repository transaction draft, and
 * for a read it is a disposable snapshot or preview draft.
 */
export interface OperationHandlerContext<
  N extends OperationName = OperationName
> {
  readonly operationName: N;
  readonly actor: ActorContext;
  readonly state: SharedStateWithCatalogs;
  readonly readOnly: boolean;
  readonly preview: boolean;
  readonly metadata?: InvocationMetadata;
  readonly principal?: TrustedPrincipal;
  /** The exact policy instance used by OperationService for this invocation. */
  readonly authorizationPolicy?: AuthorizationPolicy;
  /** The effective environment used by the same execution policy. */
  readonly environment?: AuthorizationEnvironment;
  readonly trace: OperationTraceContext;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  now(): Timestamp;
  nextId(prefix?: string): string;
}

/** A server operation implementation, injectable by phase-specific modules. */
export type OperationHandler<N extends OperationName = OperationName> = (
  input: OperationInputMap[N],
  context: OperationHandlerContext<N>
) => OperationOutputMap[N] | PromiseLike<OperationOutputMap[N]>;

/**
 * A thin adapter for service-owned orchestration. The callback is supplied by
 * OperationService, so an adapter cannot access repository state, transport,
 * idempotency, audit, trace, or target execution primitives directly.
 */
export type OperationBoundaryAdapter<N extends OperationName = OperationName> = (
  input: OperationInputMap[N],
  context: OperationHandlerContext<N>,
  execute: () => PromiseLike<OperationOutputMap[N]>
) => OperationOutputMap[N] | PromiseLike<OperationOutputMap[N]>;

export type OperationBoundaryAdapterMap = Partial<{
  [N in OperationName]: OperationBoundaryAdapter<N>;
}>;

/** Partial registry deliberately allows later phase modules to register handlers. */
export type OperationHandlerMap = Partial<{
  [N in OperationName]: OperationHandler<N>;
}>;

/** Server-only context supplied by a trusted composition root or test seam. */
export interface OperationInvocationContext {
  principal?: TrustedPrincipal;
  resourceScope?: ResourceScopeRequirement;
  consent?: ConsentContext;
  mode?: AuthorizationMode;
  environment?: AuthorizationEnvironment;
}

export type OperationPrincipalResolver = (
  invocation: OperationInvocation,
  context?: OperationInvocationContext
) => TrustedPrincipal | null | undefined | PromiseLike<TrustedPrincipal | null | undefined>;

export interface OperationServiceOptions {
  repository?: SharedStateRepository;
  handlers?: OperationHandlerMap;
  /** Thin adapters for service-owned plan/approval orchestration. */
  orchestrationAdapters?: OperationBoundaryAdapterMap;
  /** Compatibility spelling for hosts that call these approval adapters. */
  approvalAdapters?: OperationBoundaryAdapterMap;
  /** Optional trusted policy. Legacy callers without this remain compatible. */
  authorizationPolicy?: AuthorizationPolicy;
  /** Static trusted principal for workers/embedding hosts. */
  principal?: TrustedPrincipal;
  /** Additive spelling used by composition roots. */
  trustedPrincipal?: TrustedPrincipal;
  /** Per-invocation trusted identity seam for HTTP/worker adapters. */
  principalResolver?: OperationPrincipalResolver;
  /** Additive spelling for hosts that already use resolvePrincipal. */
  resolvePrincipal?: OperationPrincipalResolver;
  environment?: AuthorizationEnvironment;
  idempotencyTtlMs?: number;
  approvalTtlMs?: number;
  /** Optional deterministic trace IDs; default IDs are server-private UUIDs. */
  traceIdentifiers?: TraceIdentifierFactory;
}

interface RawInvocation {
  name: unknown;
  input: unknown;
  actor: unknown;
  metadata?: unknown;
}

interface LedgerContext {
  scopeHash: string;
  requestFingerprint: string;
  idempotencyKey: string;
}

interface PreparedInvocation {
  name: OperationName;
  input: OperationInputMap[OperationName];
  actor: ActorContext;
  metadata?: InvocationMetadata;
  descriptor: ReturnType<typeof getOperationDescriptor>;
  principal?: TrustedPrincipal;
  correlationId: string;
  trace: OperationTraceContext;
  ledger?: LedgerContext;
  invocationContext?: OperationInvocationContext;
  /** Legacy calls retain the historical activity payload compatibility. */
  legacy: boolean;
}

/** Internal signal: replay activity is already persisted, so do not audit twice. */
class ReplayedInvocationError extends Error {
  constructor(readonly pipelineError: PipelineError) {
    super('replayed invocation');
    this.name = 'ReplayedInvocationError';
  }
}

function isRepository(value: unknown): value is SharedStateRepository {
  return (
    value instanceof SharedStateRepository ||
    (typeof value === 'object' &&
      value !== null &&
      typeof (value as Partial<SharedStateRepository>).read === 'function' &&
      typeof (value as Partial<SharedStateRepository>).appendActivity ===
        'function' &&
      typeof (value as Partial<SharedStateRepository>).transactAsync ===
        'function')
  );
}

function isInvocationRecord(value: unknown): value is OperationInvocation {
  return isPlainObject(value) && 'name' in value && 'input' in value && 'actor' in value;
}

function toJsonSafe(value: unknown): unknown {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? null : JSON.parse(encoded);
  } catch {
    return '[unserializable value]';
  }
}

/** Activity input is an object by contract, even for malformed invocations. */
function activityInput(value: unknown): JsonObject {
  if (isPlainObject(value)) return deepClone(value) as JsonObject;
  return { value: toJsonSafe(value) as JsonObject['value'] };
}

function activityActor(value: unknown): ActorContext {
  if (isPlainObject(value)) {
    const actorType = value.actorType;
    const actorId = value.actorId;
    if (
      (actorType === 'human_ui' || actorType === 'agent') &&
      typeof actorId === 'string' &&
      actorId.trim().length > 0
    ) {
      return { actorType, actorId };
    }
  }
  return { actorType: 'human_ui', actorId: 'unknown-actor' };
}

function operationNameForActivity(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'unknown_operation';
}

function asPipelineError(error: unknown): PipelineError {
  if (error instanceof PipelineError) return error;
  return new InternalError('Internal server error');
}

/** Serialize and contract-check an operation output before committing it. */
function serializeOutput<N extends OperationName>(
  name: N,
  output: unknown
): OperationOutputMap[N] {
  const validated = validateOperationOutput(name, output);
  try {
    const encoded = JSON.stringify(validated);
    if (encoded === undefined) throw new Error('output is not JSON serializable');
    return JSON.parse(encoded) as OperationOutputMap[N];
  } catch (error) {
    if (error instanceof PipelineError) throw error;
    throw new InternalError(`Operation ${name} produced an invalid output`);
  }
}

function randomIdentifier(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function phaseFor(name: OperationName, readOnly: boolean): ActivityPhase {
  if (name === 'plan_operation') return 'plan';
  if (name === 'approve_operation_plan' || name === 'reject_operation_plan') {
    return 'approval';
  }
  if (name === 'commit_operation_plan') return 'commit';
  return readOnly ? 'read' : 'commit';
}

function approvalIdFromInput(
  input: unknown,
  metadata: InvocationMetadata | undefined
): ApprovalId | undefined {
  if (metadata?.approvalId !== undefined) return metadata.approvalId;
  if (!isPlainObject(input) || typeof input.approvalId !== 'string') return undefined;
  return input.approvalId.trim().length > 0
    ? (input.approvalId as ApprovalId)
    : undefined;
}

function isTrustedHuman(principal: TrustedPrincipal | undefined, actor: ActorContext): boolean {
  if (principal !== undefined) {
    return (
      principal.authenticated &&
      principal.trusted &&
      principal.authenticationStatus === 'authenticated' &&
      principal.actor.actorType === 'human_ui'
    );
  }
  // Without a configured policy this is the legacy compatibility fallback.
  return actor.actorType === 'human_ui';
}

function stateMapMaterial(
  map: Map<string, unknown>
): Array<{ id: string; value: unknown }> {
  return [...map.entries()]
    .map(([id, value]) => ({ id, value: deepClone(value) }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** Hash domain state while excluding audit/approval metadata and revision. */
function domainStateFingerprint(state: SharedStateWithCatalogs): string {
  const material = {
    jobs: stateMapMaterial(state.jobs as Map<string, unknown>),
    candidates: stateMapMaterial(state.candidates as Map<string, unknown>),
    applications: stateMapMaterial(state.applications as Map<string, unknown>),
    panels: stateMapMaterial(state.panels as Map<string, unknown>),
    interviews: stateMapMaterial(state.interviews as Map<string, unknown>),
    scorecards: stateMapMaterial(state.scorecards as Map<string, unknown>),
    offers: stateMapMaterial(state.offers as Map<string, unknown>),
    onboardingTasks: stateMapMaterial(state.onboardingTasks as Map<string, unknown>),
    backgroundChecks: stateMapMaterial(state.backgroundChecks as Map<string, unknown>),
    benefitsEnrollments: stateMapMaterial(
      state.benefitsEnrollments as Map<string, unknown>
    ),
    sourcedProspects: stateMapMaterial(
      state.sourcedProspects as Map<string, unknown>
    ),
    catalogs: {
      availabilityCalendar: [...state.catalogs.availabilityCalendar.entries()]
        .map(([interviewerId, freeSlots]) => ({ interviewerId, freeSlots }))
        .sort((left, right) => left.interviewerId.localeCompare(right.interviewerId)),
      roleTemplates: deepClone(state.catalogs.roleTemplates),
      planCatalog: deepClone(state.catalogs.planCatalog),
      startDate: state.catalogs.startDate
    }
  };
  return createHash('sha256')
    .update(canonicalJsonString(material, 'stateFingerprint'), 'utf8')
    .digest('hex');
}

const DIFF_COLLECTIONS: readonly { key: string; type: string }[] = [
  { key: 'jobs', type: 'Job_Requisition' },
  { key: 'candidates', type: 'Candidate_Record' },
  { key: 'applications', type: 'Application_Record' },
  { key: 'panels', type: 'Interview_Panel' },
  { key: 'interviews', type: 'Interview_Record' },
  { key: 'scorecards', type: 'Scorecard_Record' },
  { key: 'offers', type: 'Offer_Record' },
  { key: 'onboardingTasks', type: 'Onboarding_Task_Record' },
  { key: 'backgroundChecks', type: 'Background_Check_Record' },
  { key: 'benefitsEnrollments', type: 'Benefits_Enrollment_Record' },
  { key: 'sourcedProspects', type: 'Sourced_Prospect_Record' }
];

function changedRecords(
  before: SharedStateWithCatalogs,
  after: SharedStateWithCatalogs
): ApprovalCardRecord['affectedRecords'] {
  const result: ApprovalCardRecord['affectedRecords'] = [];
  for (const collection of DIFF_COLLECTIONS) {
    const beforeMap = (before as unknown as Record<string, unknown>)[collection.key] as
      | Map<string, unknown>
      | undefined;
    const afterMap = (after as unknown as Record<string, unknown>)[collection.key] as
      | Map<string, unknown>
      | undefined;
    const beforeValues = beforeMap ?? new Map<string, unknown>();
    const afterValues = afterMap ?? new Map<string, unknown>();
    const ids = new Set([...beforeValues.keys(), ...afterValues.keys()]);
    for (const id of [...ids].sort()) {
      const previous = beforeValues.get(id);
      const next = afterValues.get(id);
      if (previous === undefined && next !== undefined) {
        result.push({
          type: collection.type,
          id: id as GeneratedIdPlaceholder | string,
          effect: 'create'
        });
      } else if (previous !== undefined && next === undefined) {
        result.push({ type: collection.type, id, effect: 'withdraw' });
      } else if (
        previous !== undefined &&
        next !== undefined &&
        canonicalJsonString(previous, 'beforeRecord') !==
          canonicalJsonString(next, 'afterRecord')
      ) {
        result.push({ type: collection.type, id, effect: 'update' });
      }
    }
  }
  return result;
}

function resourceScopeFor(
  name: OperationName,
  input: unknown,
  principal?: TrustedPrincipal
): ResourceScopeRequirement | undefined {
  if (!isPlainObject(input)) return undefined;
  const value = (field: string): string | undefined =>
    typeof input[field] === 'string' ? input[field] : undefined;
  const ids = (field: string): string[] =>
    Array.isArray(input[field])
      ? input[field].filter((entry): entry is string => typeof entry === 'string')
      : [];

  switch (name) {
    case 'search_candidates':
      return { resourceType: 'candidate', mode: 'assigned' };
    case 'search_public_candidates':
      return { resourceType: 'prospect' };
    case 'get_candidate_profile':
      return value('candidateId') === undefined
        ? undefined
        : { resourceType: 'candidate', resourceIds: [value('candidateId')!] };
    case 'submit_application':
      return value('candidateId') === undefined
        ? undefined
        : { resourceType: 'candidate', resourceIds: [value('candidateId')!] };
    case 'compare_candidates': {
      const candidateIds = ids('candidateIds');
      return candidateIds.length === 0
        ? undefined
        : { resourceType: 'candidate', resourceIds: candidateIds };
    }
    case 'create_job_requisition':
      return { resourceType: 'job', mode: 'assigned' };
    case 'answer_candidate_faq':
      if (principal?.roles.includes('candidate')) return undefined;
      return value('jobId') === undefined
        ? undefined
        : { resourceType: 'job', resourceIds: [value('jobId')!] };
    case 'get_interview_kit':
      return value('jobId') === undefined
        ? undefined
        : { resourceType: 'job', resourceIds: [value('jobId')!] };
    case 'check_interviewer_availability':
      return value('panelId') === undefined
        ? undefined
        : { resourceType: 'panel', resourceIds: [value('panelId')!] };
    case 'propose_interview_slots':
    case 'book_interview':
    case 'get_panel_feedback_summary':
      return value('applicationId') === undefined
        ? undefined
        : { resourceType: 'application', resourceIds: [value('applicationId')!] };
    case 'submit_interview_feedback':
      return value('interviewId') === undefined
        ? undefined
        : { resourceType: 'interview', resourceIds: [value('interviewId')!] };
    case 'generate_offer':
      return value('applicationId') === undefined
        ? undefined
        : { resourceType: 'application', resourceIds: [value('applicationId')!] };
    case 'send_offer':
    case 'respond_to_offer':
    case 'initiate_background_check':
    case 'enroll_benefits':
    case 'generate_onboarding_checklist':
    case 'get_onboarding_status':
      return value('offerId') === undefined
        ? undefined
        : { resourceType: 'offer', resourceIds: [value('offerId')!] };
    case 'coordinate_interview_workflow':
      return value('applicationId') === undefined
        ? undefined
        : { resourceType: 'application', resourceIds: [value('applicationId')!] };
    case 'coordinate_onboarding_workflow':
      return value('offerId') === undefined
        ? undefined
        : { resourceType: 'offer', resourceIds: [value('offerId')!] };
    case 'import_public_prospect':
      return { resourceType: 'prospect' };
    case 'revoke_public_prospect_consent':
      return value('sourcedProspectId') === undefined
        ? undefined
        : { resourceType: 'prospect', resourceIds: [value('sourcedProspectId')!] };
    case 'plan_operation': {
      const target = input.targetOperation;
      return typeof target === 'string' && PLANABLE_OPERATION_NAMES.includes(target as never)
        ? resourceScopeFor(target as OperationName, input.input, principal)
        : undefined;
    }
    default:
      return undefined;
  }
}

function assertCandidateFaqOpenJob(
  name: OperationName,
  input: unknown,
  principal: TrustedPrincipal | undefined,
  state: SharedStateWithCatalogs
): void {
  if (name !== 'answer_candidate_faq' || !principal?.roles.includes('candidate')) {
    return;
  }
  if (!isPlainObject(input) || typeof input.jobId !== 'string') return;

  const job = state.jobs.get(input.jobId);
  if (job !== undefined && job.status !== 'open') {
    throw new ForbiddenError('You do not have permission to perform this action', {
      reason: 'resource_scope',
      resourceScope: 'job:open'
    });
  }
}

function consentForInput(value: unknown): ConsentContext | undefined {
  const candidate =
    isPlainObject(value) &&
    typeof value.targetOperation === 'string' &&
    isPlainObject(value.input)
      ? value.input
      : value;
  if (!isPlainObject(candidate) || !isPlainObject(candidate.consent)) {
    return undefined;
  }
  const consent = candidate.consent;
  return {
    status: 'explicit',
    ...(typeof consent.scope === 'string' ? { scope: consent.scope } : {}),
    ...(typeof consent.policyVersion === 'string'
      ? { policyVersion: consent.policyVersion }
      : {}),
    ...(typeof consent.evidenceRef === 'string'
      ? { reference: consent.evidenceRef }
      : {})
  };
}

function effectiveApprovalStatus(
  card: ApprovalCardRecord,
  name: OperationName,
  now: Timestamp
): ApprovalCardRecord['status'] {
  const expiresAt = Date.parse(card.expiresAt);
  const nowMillis = Date.parse(now);
  const expired =
    (card.status === 'pending' || card.status === 'approved') &&
    Number.isFinite(expiresAt) &&
    Number.isFinite(nowMillis) &&
    nowMillis >= expiresAt;
  if (!expired) return card.status;
  // Let the service produce the deterministic plan_expired result after it
  // materializes the terminal card state; policy must still check capability.
  return name === 'commit_operation_plan' ? 'approved' : 'expired';
}

function assertApprovalIdAgreement(
  name: OperationName,
  input: unknown,
  metadata: InvocationMetadata | undefined
): void {
  const inputApprovalId =
    isPlainObject(input) && typeof input.approvalId === 'string'
      ? input.approvalId
      : undefined;
  const metadataApprovalId = metadata?.approvalId;
  if (
    inputApprovalId !== undefined &&
    metadataApprovalId !== undefined &&
    inputApprovalId !== metadataApprovalId
  ) {
    throw new ValidationError('metadata.approvalId must match input.approvalId', {
      field: 'metadata.approvalId',
      reason: 'metadata_invalid',
      operationName: name,
      approvalId: inputApprovalId
    });
  }
}

function approvalForInput(
  repository: SharedStateRepository,
  name: OperationName,
  input: unknown,
  metadata: InvocationMetadata | undefined
): { approvalId?: string; status?: ApprovalCardRecord['status']; approvedBy?: ActorContext } | undefined {
  const metadataApprovalId = metadata?.approvalId;
  const inputApprovalId =
    isPlainObject(input) && typeof input.approvalId === 'string'
      ? input.approvalId
      : undefined;
  const approvalId = metadataApprovalId ?? inputApprovalId;
  if (approvalId === undefined) return undefined;
  const card = repository.read().approvalCards.get(approvalId);
  return {
    approvalId,
    ...(card === undefined
      ? { status: 'pending' as const }
      : { status: effectiveApprovalStatus(card, name, repository.now()) }),
    ...(card?.approvedBy === undefined ? {} : { approvedBy: card.approvedBy })
  };
}

function cardSummary(record: ApprovalCardRecord): ApprovalCardSummary {
  const proposedOutput = redactJsonObjectWithMetadata(record.proposedOutput);
  return {
    id: record.id,
    targetOperation: record.targetOperation,
    requestedBy: deepClone(record.requestedBy),
    requestedAt: record.requestedAt,
    baseRevision: record.baseRevision,
    affectedRecords: deepClone(record.affectedRecords),
    proposedOutput: proposedOutput.value,
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
      : { approvedBy: deepClone(record.approvedBy) }),
    ...(record.approvedAt === undefined ? {} : { approvedAt: record.approvedAt }),
    ...(record.rejectedBy === undefined
      ? {}
      : { rejectedBy: deepClone(record.rejectedBy) }),
    ...(record.rejectedAt === undefined ? {} : { rejectedAt: record.rejectedAt }),
    expiresAt: record.expiresAt,
    correlationId: record.correlationId,
    traceId: record.traceId,
    ...(record.committedAt === undefined ? {} : { committedAt: record.committedAt }),
    redactions: [
      'normalizedInput',
      'requestFingerprint',
      'targetFingerprint',
      ...proposedOutput.redactions
    ]
  };
}

/** Generated IDs used only by preview drafts; no repository ID source is touched. */
export class PreviewIdGenerator implements IdGenerator {
  private readonly counters = new Map<string, number>();

  next(prefix = 'id'): GeneratedIdPlaceholder {
    const normalized = prefix.trim().length > 0 ? prefix.trim() : 'id';
    const next = (this.counters.get(normalized) ?? 0) + 1;
    this.counters.set(normalized, next);
    return `preview-${normalized}-${next}` as GeneratedIdPlaceholder;
  }
}

function extractBlockers(value: unknown): string[] {
  if (!isPlainObject(value) || !Array.isArray(value.blockers)) return [];
  return value.blockers
    .filter((blocker): blocker is string => typeof blocker === 'string')
    .slice(0, 20);
}

function previewWarnings(affectedCount: number): string[] {
  return affectedCount > 20
    ? ['Only the first 20 affected records are shown in the approval summary.']
    : [];
}

function summarizeAffected(
  affected: ApprovalCardRecord['affectedRecords']
): string[] {
  const labels: Record<ApprovalCardRecord['affectedRecords'][number]['effect'], string> = {
    create: 'Create',
    update: 'Update',
    withdraw: 'Withdraw'
  };
  return affected
    .slice(0, 20)
    .map((record) => `${labels[record.effect]} ${record.type} ${record.id}`);
}

function approvalPolicyFor(
  policy: ReturnType<typeof getOperationDescriptor>['approvalPolicy']
): ApprovalCardPolicy {
  return policy === 'consent_and_human' ? 'consent_and_human' : 'human';
}

function detailsForRevision(
  expectedRevision: number,
  currentRevision: number,
  operationName: string,
  extra: Record<string, unknown> = {}
) {
  return {
    reason: 'stale_revision' as const,
    expectedRevision,
    currentRevision,
    operationName,
    ...extra
  };
}

function conflictResult(error: ConflictError): { conflict: PipelineErrorPayload } {
  return { conflict: error.toPayload() };
}

export class OperationService {
  readonly repository: SharedStateRepository;
  private readonly handlers = new Map<OperationName, OperationHandler>();
  private readonly orchestrationAdapters = new Map<
    OperationName,
    OperationBoundaryAdapter
  >();
  private readonly authorizationPolicy?: AuthorizationPolicy;
  private readonly staticPrincipal?: TrustedPrincipal;
  private readonly principalResolver?: OperationPrincipalResolver;
  private readonly environment?: AuthorizationEnvironment;
  private readonly idempotencyTtlMs: number;
  private readonly approvalTtlMs: number;
  private readonly traceIdentifiers?: TraceIdentifierFactory;
  /** Serializes ledger lookup, handler execution, and repository commit. */
  private executionTail: Promise<void> = Promise.resolve();

  constructor(
    repositoryOrOptions: SharedStateRepository | OperationServiceOptions = {},
    initialHandlers: OperationHandlerMap = {}
  ) {
    const options: OperationServiceOptions = isRepository(repositoryOrOptions)
      ? { repository: repositoryOrOptions, handlers: initialHandlers }
      : repositoryOrOptions;
    this.repository = options.repository ?? new SharedStateRepository();
    this.authorizationPolicy = options.authorizationPolicy;
    this.staticPrincipal = options.principal ?? options.trustedPrincipal;
    this.principalResolver = options.principalResolver ?? options.resolvePrincipal;
    this.environment = options.environment;
    this.idempotencyTtlMs =
      Number.isFinite(options.idempotencyTtlMs) && options.idempotencyTtlMs! > 0
        ? options.idempotencyTtlMs!
        : 24 * 60 * 60 * 1000;
    this.approvalTtlMs =
      Number.isFinite(options.approvalTtlMs) && options.approvalTtlMs! > 0
        ? options.approvalTtlMs!
        : 15 * 60 * 1000;
    this.traceIdentifiers = options.traceIdentifiers;
    this.registerHandlers({ ...(options.handlers ?? {}), ...initialHandlers });
    this.registerOrchestrationAdapters(
      options.orchestrationAdapters ?? options.approvalAdapters ?? {}
    );
  }

  /** Register one service-owned orchestration adapter. */
  registerOrchestrationAdapter<N extends OperationName>(
    name: N,
    adapter: OperationBoundaryAdapter<N>
  ): void {
    assertOperationName(name);
    if (typeof adapter !== 'function') {
      throw new TypeError(`Orchestration adapter for ${name} must be a function`);
    }
    this.orchestrationAdapters.set(name, adapter as OperationBoundaryAdapter);
  }

  /** Register the narrow adapters used by plan/approval/commit operations. */
  registerOrchestrationAdapters(adapters: OperationBoundaryAdapterMap): void {
    for (const [name, adapter] of Object.entries(adapters) as Array<[
      OperationName,
      OperationBoundaryAdapter | undefined
    ]>) {
      if (adapter !== undefined) this.registerOrchestrationAdapter(name, adapter);
    }
  }

  /** Add one phase-specific handler without changing the shared dispatcher. */
  registerHandler<N extends OperationName>(
    name: N,
    handler: OperationHandler<N>
  ): void {
    assertOperationName(name);
    if (typeof handler !== 'function') {
      throw new TypeError(`Handler for ${name} must be a function`);
    }
    this.handlers.set(name, handler as OperationHandler);
  }

  /** Register any subset of the canonical operation handlers. */
  registerHandlers(handlers: OperationHandlerMap): void {
    for (const [name, handler] of Object.entries(handlers) as Array<[
      OperationName,
      OperationHandler | undefined
    ]>) {
      if (handler !== undefined) this.registerHandler(name, handler);
    }
  }

  hasHandler(name: OperationName): boolean {
    return this.handlers.has(name);
  }

  getHandler<N extends OperationName>(name: N): OperationHandler<N> | undefined {
    return this.handlers.get(name) as OperationHandler<N> | undefined;
  }

  /**
   * Execute either the legacy `(name, input, actor)` call or a metadata-aware
   * `OperationInvocation` envelope. Metadata is never merged into operation
   * input; the optional second envelope argument is server-only context.
   */
  async invoke<N extends OperationName>(
    invocation: OperationInvocation<N>,
    context?: OperationInvocationContext
  ): Promise<OperationOutput<N>>;
  async invoke<N extends OperationName>(
    name: N,
    input: OperationInput<N>,
    actor: ActorContext
  ): Promise<OperationOutput<N>>;
  async invoke<N extends OperationName>(
    first: N | OperationInvocation<N>,
    second?: OperationInput<N> | OperationInvocationContext,
    third?: ActorContext
  ): Promise<OperationOutput<N>> {
    const envelope = isInvocationRecord(first);
    const raw: RawInvocation = envelope
      ? {
          name: (first as OperationInvocation).name,
          input: (first as OperationInvocation).input,
          actor: (first as OperationInvocation).actor,
          metadata: (first as OperationInvocation).metadata
        }
      : { name: first, input: second, actor: third };
    const context = envelope
      ? (second as OperationInvocationContext | undefined)
      : undefined;
    return this.enqueue(() =>
      this.executeInvocation<N>(raw, context, !envelope)
    );
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.executionTail.then(work, work);
    this.executionTail = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async executeInvocation<N extends OperationName>(
    raw: RawInvocation,
    invocationContext: OperationInvocationContext | undefined,
    legacy: boolean
  ): Promise<OperationOutput<N>> {
    const auditName = operationNameForActivity(raw.name);
    const auditActor = activityActor(raw.actor);
    const rawInput = activityInput(raw.input);
    let prepared: PreparedInvocation | undefined;
    let ledgerContext: LedgerContext | undefined;

    try {
      assertOperationName(raw.name);
      const actor = assertActorContext(raw.actor);
      const input = validateOperationInput(raw.name, raw.input);
      const metadata = normalizeInvocationMetadata(raw.metadata);
      assertApprovalIdAgreement(raw.name, input, metadata);
      const descriptor = getOperationDescriptor(raw.name);
      const principal = await this.resolvePrincipal(
        { name: raw.name, input, actor, ...(metadata === undefined ? {} : { metadata }) },
        invocationContext
      );
      if (
        principal !== undefined &&
        principal.authenticated &&
        principal.trusted &&
        (principal.actor.actorType !== actor.actorType ||
          principal.actor.actorId !== actor.actorId)
      ) {
        throw new ForbiddenError('Invocation actor does not match the trusted principal', {
          reason: 'not_authenticated'
        });
      }

      const continuation = this.traceContinuationFor(input, metadata);
      const correlationId =
        metadata?.correlationId ?? continuation.correlationId ?? randomIdentifier('correlation');
      const trace = createOperationTrace({
        operationName: raw.name,
        now: () => this.repository.now(),
        ...(metadata?.parentSpanId === undefined
          ? continuation.parentSpanId === undefined
            ? {}
            : { parentSpanId: continuation.parentSpanId }
          : { parentSpanId: metadata.parentSpanId }),
        ...(continuation.traceId === undefined ? {} : { traceId: continuation.traceId }),
        ...(this.traceIdentifiers === undefined
          ? {}
          : { identifiers: this.traceIdentifiers })
      });
      prepared = {
        name: raw.name,
        input,
        actor,
        ...(metadata === undefined ? {} : { metadata }),
        descriptor,
        ...(principal === undefined ? {} : { principal }),
        correlationId,
        trace,
        invocationContext,
        legacy
      };

      if (
        !legacy &&
        (raw.name === 'plan_operation' ||
          raw.name === 'approve_operation_plan' ||
          raw.name === 'reject_operation_plan' ||
          raw.name === 'commit_operation_plan' ||
          raw.name === 'coordinate_interview_workflow' ||
          raw.name === 'coordinate_onboarding_workflow') &&
        metadata?.idempotencyKey === undefined
      ) {
        throw new ValidationError(
          `Operation ${raw.name} requires an idempotency key`,
          {
            field: 'metadata.idempotencyKey',
            reason: 'metadata_invalid'
          }
        );
      }

      const requestActor = principal?.actor ?? actor;
      if (metadata?.idempotencyKey !== undefined) {
        const scopeInput: InvocationScopeInput = {
          operationName: raw.name,
          actor: requestActor,
          idempotencyKey: metadata.idempotencyKey,
          ...(principal?.tenantId === undefined
            ? {}
            : { tenantId: principal.tenantId }),
          ...(principal === undefined
            ? {}
            : {
                scopeClaims: principal.resourceScopes.map(
                  (scope) =>
                    `${scope.resourceType}:${scope.mode}:${[
                      ...(scope.resourceIds ?? scope.ids ?? [])
                    ].sort().join(',')}`
                )
              })
        };
        ledgerContext = {
          scopeHash: createInvocationScopeHash(scopeInput),
          requestFingerprint: createInvocationRequestFingerprint(
            raw.name,
            input,
            requestActor,
            metadata
          ),
          idempotencyKey: metadata.idempotencyKey
        };
        prepared.ledger = ledgerContext;
      }

      await this.authorize(prepared);

      const replay = await this.replayIfPresent(prepared);
      if (replay !== undefined) return replay as OperationOutput<N>;

      const output = await this.executeAuthorized(prepared);
      return output as OperationOutput<N>;
    } catch (error) {
      if (error instanceof ReplayedInvocationError) {
        throw error.pipelineError;
      }

      const pipelineError = asPipelineError(error);
      const trace = prepared?.trace ??
        createOperationTrace({
          operationName: auditName,
          now: () => this.repository.now(),
          ...(this.traceIdentifiers === undefined
            ? {}
            : { identifiers: this.traceIdentifiers })
        });
      trace.finish('failed', {
        code: pipelineError.code,
        ...(pipelineError.details?.reason === undefined
          ? {}
          : { reason: pipelineError.details.reason })
      });
      const failure = this.appendFailure(
        auditName,
        prepared?.actor ?? auditActor,
        prepared?.input === undefined ? rawInput : activityInput(prepared.input),
        pipelineError,
        prepared?.correlationId ?? randomIdentifier('correlation'),
        trace,
        prepared === undefined ? undefined : phaseFor(prepared.name, prepared.descriptor.readOnly),
        prepared?.metadata?.approvalId,
        prepared?.metadata,
        legacy
      );

      if (
        ledgerContext !== undefined &&
        pipelineError.details?.reason !== 'idempotency_key_reuse'
      ) {
        const createdAt = this.repository.now();
        const entry: InvocationLedgerEntry = {
          scopeHash: ledgerContext.scopeHash,
          requestFingerprint: ledgerContext.requestFingerprint,
          operationName: auditName,
          status: 'error',
          responseOrError: cloneLedgerJson(pipelineError.toPayload() as unknown as JsonObject),
          originalActivityId: failure.activityId,
          originalRevision: failure.revision,
          correlationId: prepared?.correlationId ?? randomIdentifier('correlation'),
          traceId: trace.traceId,
          createdAt,
          expiresAt: expiryTimestamp(createdAt, this.idempotencyTtlMs)
        };
        this.repository.invocationLedger.set(ledgerContext.scopeHash, entry);
      }
      throw pipelineError;
    }
  }

  private async resolvePrincipal(
    invocation: OperationInvocation,
    context?: OperationInvocationContext
  ): Promise<TrustedPrincipal | undefined> {
    const supplied = context?.principal ?? this.staticPrincipal;
    const resolver = this.principalResolver;
    if (resolver !== undefined) {
      const resolved = await resolver(invocation, context);
      if (resolved !== undefined && resolved !== null) return resolved;
    }
    if (supplied !== undefined) return supplied;
    if (this.authorizationPolicy !== undefined) {
      // The unauthenticated principal is deliberately fail-closed. It keeps
      // authorization decisions and failure audits structured without turning
      // the caller-provided actor into an authenticated identity.
      return createUnauthenticatedPrincipal('missing_principal');
    }
    return undefined;
  }

  private async authorize(prepared: PreparedInvocation): Promise<void> {
    if (this.authorizationPolicy === undefined) return;
    assertCandidateFaqOpenJob(
      prepared.name,
      prepared.input,
      prepared.principal,
      this.repository.read()
    );
    const decision = await this.authorizationPolicy.decide({
      principal: prepared.principal ?? createUnauthenticatedPrincipal(),
      operation: prepared.name,
      mode: prepared.invocationContext?.mode ?? this.defaultMode(prepared.name),
      resourceScope:
        prepared.invocationContext?.resourceScope ??
        resourceScopeFor(prepared.name, prepared.input, prepared.principal),
      approval: approvalForInput(
        this.repository,
        prepared.name,
        prepared.input,
        prepared.metadata
      ),
      consent:
        prepared.invocationContext?.consent ?? consentForInput(prepared.input),
      environment: prepared.invocationContext?.environment ?? this.environment
    });
    if (!decision.allowed) throw authorizationDecisionError(decision);
  }

  private policyVersionFor(prepared: PreparedInvocation): string | undefined {
    return prepared.principal?.policyVersion ?? this.authorizationPolicy?.policyVersion;
  }

  private async authorizeTarget(
    prepared: PreparedInvocation,
    targetOperation: OperationName,
    targetInput: unknown,
    mode: AuthorizationMode,
    approval?: { approvalId?: string; status?: ApprovalCardRecord['status']; approvedBy?: ActorContext },
    options: {
      resourceScope?: ResourceScopeRequirement;
      consent?: ConsentContext;
    } = {}
  ): Promise<void> {
    if (this.authorizationPolicy === undefined) return;
    const principal = prepared.principal ?? createUnauthenticatedPrincipal();
    const decision = await this.authorizationPolicy.decide({
      principal,
      operation: targetOperation,
      mode,
      resourceScope:
        options.resourceScope ??
        prepared.invocationContext?.resourceScope ??
        resourceScopeFor(targetOperation, targetInput, principal),
      approval,
      consent:
        options.consent ??
        prepared.invocationContext?.consent ??
        consentForInput(targetInput),
      environment: prepared.invocationContext?.environment ?? this.environment
    });
    if (!decision.allowed) throw authorizationDecisionError(decision);
  }

  private approvalTargetForCard(card: ApprovalCardRecord): {
    targetName: OperationName;
    targetInput: OperationInputMap[OperationName];
  } {
    assertOperationName(card.targetOperation);
    const targetName = card.targetOperation;
    if (!(PLANABLE_OPERATION_NAMES as readonly string[]).includes(targetName)) {
      throw new ValidationError('The approval target is no longer planable', {
        field: 'approvalCard.targetOperation',
        reason: 'unsupported_mode',
        approvalId: card.id
      });
    }
    const descriptor = getOperationDescriptor(targetName);
    if (!descriptor.planable) {
      throw new ValidationError('The approval target is not planable', {
        field: 'approvalCard.targetOperation',
        reason: 'unsupported_mode',
        approvalId: card.id
      });
    }
    return {
      targetName,
      targetInput: validateOperationInput(targetName, card.normalizedInput)
    };
  }

  private async authorizeCardTarget(
    prepared: PreparedInvocation,
    card: ApprovalCardRecord,
    mode: AuthorizationMode
  ): Promise<{
    targetName: OperationName;
    targetInput: OperationInputMap[OperationName];
  }> {
    const { targetName, targetInput } = this.approvalTargetForCard(card);
    await this.authorizeTarget(
      prepared,
      targetName,
      targetInput,
      mode,
      { approvalId: card.id, status: card.status, approvedBy: card.approvedBy },
      {
        // Never let an approval operation's caller-supplied scope or consent
        // replace the scope/consent captured in the protected target input.
        resourceScope: resourceScopeFor(targetName, targetInput, prepared.principal),
        consent: consentForInput(targetInput)
      }
    );
    return { targetName, targetInput };
  }

  private assertCardPolicyVersion(
    prepared: PreparedInvocation,
    card: ApprovalCardRecord
  ): void {
    if (card.policyVersion === undefined) return;
    const current = this.policyVersionFor(prepared);
    if (current !== card.policyVersion) {
      throw new ConflictError('The approval policy changed after planning', {
        reason: 'entity_changed',
        approvalId: card.id,
        operationName: card.targetOperation,
        policyVersion: card.policyVersion,
        currentPolicyVersion: current
      });
    }
  }

  private traceContinuationFor(
    input: unknown,
    metadata: InvocationMetadata | undefined
  ): {
    correlationId?: string;
    traceId?: string;
    parentSpanId?: string;
  } {
    const approvalId = approvalIdFromInput(input, metadata);
    if (approvalId === undefined) return {};
    const card = this.repository.read().approvalCards.get(approvalId);
    if (card === undefined) return {};
    const previous = [...this.repository.read().activityLog]
      .reverse()
      .find(
        (entry) =>
          entry.approvalId === approvalId ||
          entry.input.approvalId === approvalId ||
          entry.output.approvalId === approvalId
      );
    return {
      correlationId: card.correlationId,
      traceId: card.traceId,
      ...(previous?.spanId === undefined ? {} : { parentSpanId: previous.spanId })
    };
  }

  private defaultMode(name: OperationName): AuthorizationMode {
    if (name === 'plan_operation') return 'plan';
    if (name === 'approve_operation_plan' || name === 'reject_operation_plan') {
      return 'approval';
    }
    return getOperationDescriptor(name).executionClass;
  }

  private async replayIfPresent(
    prepared: PreparedInvocation
  ): Promise<OperationOutputMap[OperationName] | undefined> {
    const ledgerContext = prepared.ledger;
    if (ledgerContext === undefined) return undefined;
    const entry = getLiveInvocationLedgerEntry(
      this.repository.invocationLedger,
      ledgerContext.scopeHash,
      this.repository.now()
    );
    if (entry === undefined) return undefined;

    if (
      entry.operationName !== prepared.name ||
      entry.requestFingerprint !== ledgerContext.requestFingerprint
    ) {
      throw new ConflictError('Idempotency key was already used for another request', {
        reason: 'idempotency_key_reuse',
        operationName: prepared.name,
        originalActivityId: entry.originalActivityId
      });
    }

    await this.appendReplayActivity(prepared, entry);
    if (entry.status === 'error') {
      throw new ReplayedInvocationError(PipelineError.from(entry.responseOrError));
    }
    return deepClone(entry.responseOrError) as unknown as OperationOutputMap[OperationName];
  }

  private async appendReplayActivity(
    prepared: PreparedInvocation,
    entry: InvocationLedgerEntry
  ): Promise<void> {
    const replaySpan = prepared.trace.startChild('idempotency.replay', {
      originalActivityId: entry.originalActivityId
    });
    prepared.trace.completeSpan(replaySpan, 'completed');
    prepared.trace.finish('completed', { replayed: true });
    const activity = this.createActivityEntry(
      prepared.name,
      prepared.actor,
      activityInput(prepared.input),
      entry.responseOrError,
      prepared,
      'replay',
      true,
      entry.originalActivityId
    );
    this.repository.appendActivity(activity);
  }

  private async executeAuthorized(
    prepared: PreparedInvocation
  ): Promise<OperationOutputMap[OperationName]> {
    switch (prepared.name) {
      case 'plan_operation':
        return this.executeBoundaryAdapter(prepared, () => this.executePlan(prepared));
      case 'get_approval_card':
        return this.executeBoundaryAdapter(prepared, () =>
          this.executeGetApprovalCard(prepared)
        );
      case 'approve_operation_plan':
        return this.executeBoundaryAdapter(prepared, () =>
          this.executeApprovalChange(prepared, 'approved')
        );
      case 'reject_operation_plan':
        return this.executeBoundaryAdapter(prepared, () =>
          this.executeApprovalChange(prepared, 'rejected')
        );
      case 'commit_operation_plan':
        return this.executeBoundaryAdapter(prepared, () =>
          this.executeCommitPlan(prepared)
        );
      default:
        break;
    }

    const handler = this.handlers.get(prepared.name);
    if (handler === undefined) {
      throw new InternalError(
        `Operation handler is not configured: ${prepared.name}`,
        { field: 'operationName' }
      );
    }

    if (prepared.descriptor.readOnly) {
      return this.executeRead(prepared, handler);
    }
    return this.executeMutation(prepared, handler);
  }

  private async executeBoundaryAdapter(
    prepared: PreparedInvocation,
    execute: () => Promise<OperationOutputMap[OperationName]>
  ): Promise<OperationOutputMap[OperationName]> {
    const adapter = this.orchestrationAdapters.get(prepared.name);
    if (adapter === undefined) return execute();

    const snapshot = this.repository.read();
    const context = this.createHandlerContext(
      prepared.name,
      prepared.actor,
      snapshot,
      false,
      false,
      prepared
    );
    return adapter(
      deepClone(prepared.input) as never,
      context as never,
      execute as never
    ) as Promise<OperationOutputMap[OperationName]>;
  }

  private async executeRead(
    prepared: PreparedInvocation,
    handler: OperationHandler
  ): Promise<OperationOutputMap[OperationName]> {
    const snapshot = this.repository.read();
    const child = prepared.trace.startChild(`handler:${prepared.name}`);
    let output: OperationOutputMap[OperationName];
    try {
      const rawOutput = await handler(
        deepClone(prepared.input),
        this.createHandlerContext(
          prepared.name,
          prepared.actor,
          snapshot,
          true,
          false,
          prepared
        )
      );
      output = serializeOutput(prepared.name, rawOutput);
      prepared.trace.completeSpan(child, 'completed');
    } catch (error) {
      prepared.trace.completeSpan(child, 'failed');
      throw error;
    }
    prepared.trace.finish('completed');
    const activity = this.createActivityEntry(
      prepared.name,
      prepared.actor,
      activityInput(prepared.input),
      output as unknown as JsonObject,
      prepared,
      'read'
    );
    const committed = this.repository.appendActivity(activity);
    this.persistSuccessLedger(
      prepared,
      output as unknown as JsonObject,
      activity.id,
      committed.revision
    );
    return output;
  }

  private async executeReadResult(
    prepared: PreparedInvocation,
    producer: () => unknown
  ): Promise<OperationOutputMap[OperationName]> {
    const child = prepared.trace.startChild(`handler:${prepared.name}`);
    let output: OperationOutputMap[OperationName];
    try {
      output = serializeOutput(prepared.name, producer());
      prepared.trace.completeSpan(child, 'completed');
    } catch (error) {
      prepared.trace.completeSpan(child, 'failed');
      throw error;
    }
    prepared.trace.finish('completed');
    const activity = this.createActivityEntry(
      prepared.name,
      prepared.actor,
      activityInput(prepared.input),
      output as unknown as JsonObject,
      prepared,
      'read'
    );
    const committed = this.repository.appendActivity(activity);
    this.persistSuccessLedger(
      prepared,
      output as unknown as JsonObject,
      activity.id,
      committed.revision
    );
    return output;
  }

  private async executeMutation(
    prepared: PreparedInvocation,
    handler: OperationHandler
  ): Promise<OperationOutputMap[OperationName]> {
    const expectedRevision = prepared.metadata?.expectedRevision;
    const currentRevision = this.repository.getRevision();
    if (
      expectedRevision !== undefined &&
      expectedRevision !== currentRevision
    ) {
      throw new ConflictError('The operation was based on a stale revision',
        detailsForRevision(expectedRevision, currentRevision, prepared.name));
    }

    const result = await this.repository.transactAsync(async (draft) => {
      this.assertAtomicRevision(prepared, draft.revision);
      const child = prepared.trace.startChild(`handler:${prepared.name}`);
      let output: OperationOutputMap[OperationName];
      try {
        const rawOutput = await handler(
          deepClone(prepared.input),
          this.createHandlerContext(
            prepared.name,
            prepared.actor,
            draft,
            false,
            false,
            prepared
          )
        );
        output = serializeOutput(prepared.name, rawOutput);
        prepared.trace.completeSpan(child, 'completed');
      } catch (error) {
        prepared.trace.completeSpan(child, 'failed');
        throw error;
      }
      prepared.trace.finish('completed');
      const activity = this.createActivityEntry(
        prepared.name,
        prepared.actor,
        activityInput(prepared.input),
        output as unknown as JsonObject,
        prepared,
        'commit'
      );
      draft.activityLog.push(activity);
      return {
        output,
        activityId: activity.id,
        revision: draft.revision + 1
      };
    });

    this.persistSuccessLedger(
      prepared,
      result.output as unknown as JsonObject,
      result.activityId,
      result.revision
    );
    return result.output;
  }

  private async executePlan(
    prepared: PreparedInvocation
  ): Promise<OperationOutputMap[OperationName]> {
    const planInput = prepared.input as unknown as PlanOperationInput;
    const targetName = planInput.targetOperation as OperationName;
    if (!(PLANABLE_OPERATION_NAMES as readonly string[]).includes(targetName)) {
      throw new ValidationError('The target operation is not planable', {
        field: 'input.targetOperation',
        reason: 'unsupported_mode'
      });
    }
    const targetDescriptor = getOperationDescriptor(targetName);
    if (!targetDescriptor.planable) {
      throw new ValidationError('The target operation is not planable', {
        field: 'input.targetOperation',
        reason: 'unsupported_mode'
      });
    }
    const targetInput = validateOperationInput(targetName, planInput.input);
    const targetHandler = this.handlers.get(targetName);
    if (targetHandler === undefined) {
      throw new InternalError(
        `Operation handler is not configured: ${targetName}`,
        { field: 'targetOperation' }
      );
    }

    await this.authorizeTarget(
      prepared,
      targetName,
      targetInput,
      'plan',
      undefined,
      {
        resourceScope: resourceScopeFor(targetName, targetInput, prepared.principal),
        consent: consentForInput(targetInput)
      }
    );
    const baseSnapshot = this.repository.read();
    this.assertExpectedRevision(prepared, baseSnapshot.revision);
    const targetFingerprint = domainStateFingerprint(baseSnapshot);
    const previewState = deepClone(baseSnapshot);
    const previewIds = new PreviewIdGenerator();
    const child = prepared.trace.startChild(`plan:${targetName}`);
    let proposedOutput: OperationOutputMap[OperationName];
    try {
      const rawOutput = await targetHandler(
        deepClone(targetInput),
        this.createHandlerContext(
          targetName,
          prepared.actor,
          previewState,
          false,
          true,
          prepared,
          previewIds
        )
      );
      proposedOutput = serializeOutput(targetName, rawOutput);
      prepared.trace.completeSpan(child, 'completed');
    } catch (error) {
      prepared.trace.completeSpan(child, 'failed');
      throw error;
    }

    const affectedAll = changedRecords(baseSnapshot, previewState);
    const affectedRecords = affectedAll.slice(0, 20);
    const warnings = previewWarnings(affectedAll.length);
    const summary = summarizeAffected(affectedRecords);
    if (summary.length === 0) summary.push('No domain changes detected');
    const proposed = redactJsonObjectWithMetadata(proposedOutput);
    const redactions = [...new Set(proposed.redactions)].sort();
    const blockers = extractBlockers(proposedOutput);
    const policyVersion = this.policyVersionFor(prepared);
    const now = this.repository.now();
    const approvalId = this.repository.nextId('approval') as ApprovalId;
    const expiresAt = expiryTimestamp(now, this.approvalTtlMs);
    const card: ApprovalCardRecord = {
      id: approvalId,
      targetOperation: targetName,
      normalizedInput: canonicalizeJsonObject(targetInput, 'targetInput'),
      requestFingerprint: createInvocationRequestFingerprint(
        targetName,
        targetInput,
        prepared.principal?.actor ?? prepared.actor
      ),
      requestedBy: deepClone(prepared.actor),
      requestedAt: now,
      baseRevision: baseSnapshot.revision,
      targetFingerprint,
      affectedRecords: deepClone(affectedRecords),
      proposedOutput: proposed.value,
      changeSummary: summary,
      warnings,
      ...(blockers.length === 0 ? {} : { blockers }),
      requiredCapability: targetDescriptor.requiredCapability,
      approvalPolicy: approvalPolicyFor(targetDescriptor.approvalPolicy),
      ...(policyVersion === undefined ? {} : { policyVersion }),
      status: 'pending',
      expiresAt,
      correlationId: prepared.correlationId,
      traceId: prepared.trace.traceId
    };
    const output = serializeOutput('plan_operation', {
      approvalId,
      targetOperation: targetName,
      proposedOutput: proposed.value,
      changeSummary: summary,
      warnings,
      blockers,
      baseRevision: baseSnapshot.revision,
      expiresAt,
      requiredApproval: card.approvalPolicy,
      requiredCapability: card.requiredCapability,
      status: 'pending',
      ...(policyVersion === undefined ? {} : { policyVersion }),
      redactions
    });

    const result = await this.repository.transactAsync((draft) => {
      this.assertAtomicRevision(prepared, draft.revision);
      if (draft.revision !== baseSnapshot.revision) {
        throw new ConflictError('The plan snapshot is stale', {
          reason: 'stale_revision',
          expectedRevision: baseSnapshot.revision,
          currentRevision: draft.revision,
          operationName: prepared.name
        });
      }
      draft.approvalCards.set(approvalId, deepClone(card));
      prepared.trace.finish('completed');
      const activity = this.createActivityEntry(
        prepared.name,
        prepared.actor,
        activityInput(prepared.input),
        output as unknown as JsonObject,
        prepared,
        'plan',
        false,
        undefined,
        approvalId
      );
      draft.activityLog.push(activity);
      return { output, activityId: activity.id, revision: draft.revision + 1 };
    });

    this.persistSuccessLedger(
      prepared,
      result.output as unknown as JsonObject,
      result.activityId,
      result.revision
    );
    return result.output;
  }

  private async executeGetApprovalCard(
    prepared: PreparedInvocation
  ): Promise<OperationOutputMap[OperationName]> {
    const approvalId = this.requiredApprovalId(prepared.input);
    await this.materializeExpiredCard(approvalId, prepared);
    const card = this.repository.read().approvalCards.get(approvalId);
    if (card === undefined) {
      throw new NotFoundError(`Approval card ${approvalId} was not found`, {
        reason: 'approval_not_found',
        approvalId
      });
    }
    await this.authorizeCardTarget(prepared, card, 'plan');
    return this.executeReadResult(prepared, () => cardSummary(card));
  }

  private async executeApprovalChange(
    prepared: PreparedInvocation,
    status: 'approved' | 'rejected'
  ): Promise<OperationOutputMap[OperationName]> {
    if (!isTrustedHuman(prepared.principal, prepared.actor)) {
      throw new ForbiddenError('Only a trusted human may change an approval card', {
        reason: 'approval_principal_required'
      });
    }
    const approvalId = this.requiredApprovalId(prepared.input);
    await this.materializeExpiredCard(approvalId, prepared);
    const current = this.repository.read().approvalCards.get(approvalId);
    if (current === undefined) {
      throw new NotFoundError(`Approval card ${approvalId} was not found`, {
        reason: 'approval_not_found',
        approvalId
      });
    }
    if (current.status === 'expired' || this.cardExpired(current, this.repository.now())) {
      throw new ConflictError('The approval card has expired', {
        reason: 'plan_expired',
        approvalId
      });
    }
    if (current.status !== 'pending') {
      throw new ConflictError('The approval card is no longer pending', {
        reason:
          current.status === 'rejected'
            ? 'approval_rejected'
            : 'approval_required',
        approvalId
      });
    }
    await this.authorizeCardTarget(prepared, current, 'plan');

    const now = this.repository.now();
    const note =
      isPlainObject(prepared.input) &&
      typeof (prepared.input as Record<string, unknown>).note === 'string'
        ? (prepared.input as Record<string, unknown>).note as string
        : undefined;
    const policyVersion = this.policyVersionFor(prepared);
    const output = serializeOutput(
      prepared.name,
      status === 'approved'
        ? {
            approvalId,
            status: 'approved',
            approvedBy: prepared.actor,
            approvedAt: now,
            ...(note === undefined ? {} : { note }),
            ...(policyVersion === undefined ? {} : { policyVersion })
          }
        : {
            approvalId,
            status: 'rejected',
            rejectedBy: prepared.actor,
            rejectedAt: now,
            ...(note === undefined ? {} : { note }),
            ...(policyVersion === undefined ? {} : { policyVersion })
          }
    );

    const result = await this.repository.transactAsync(async (draft) => {
      this.assertAtomicRevision(prepared, draft.revision);
      const card = draft.approvalCards.get(approvalId);
      if (card === undefined) {
        throw new NotFoundError(`Approval card ${approvalId} was not found`, {
          reason: 'approval_not_found',
          approvalId
        });
      }
      if (this.cardExpired(card, now)) {
        card.status = 'expired';
        return conflictResult(
          new ConflictError('The approval card has expired', {
            reason: 'plan_expired',
            approvalId
          })
        );
      }
      if (card.status !== 'pending') {
        throw new ConflictError('The approval card is no longer pending', {
          reason:
            card.status === 'rejected'
              ? 'approval_rejected'
              : 'approval_required',
          approvalId
        });
      }
      try {
        this.assertCardPolicyVersion(prepared, card);
      } catch (error) {
        if (
          error instanceof ConflictError &&
          error.details?.reason === 'entity_changed'
        ) {
          card.status = 'expired';
          return conflictResult(error);
        }
        throw error;
      }
      await this.authorizeCardTarget(prepared, card, 'plan');
      if (status === 'approved') {
        card.status = 'approved';
        card.approvedBy = deepClone(prepared.actor);
        card.approvedAt = now;
        if (note !== undefined) card.approvalNote = note;
      } else {
        card.status = 'rejected';
        card.rejectedBy = deepClone(prepared.actor);
        card.rejectedAt = now;
        if (note !== undefined) card.rejectionNote = note;
      }
      prepared.trace.finish('completed');
      const activity = this.createActivityEntry(
        prepared.name,
        prepared.actor,
        activityInput(prepared.input),
        output as unknown as JsonObject,
        prepared,
        'approval',
        false,
        undefined,
        approvalId
      );
      draft.activityLog.push(activity);
      return { output, activityId: activity.id, revision: draft.revision + 1 };
    });

    if ('conflict' in result) throw PipelineError.from(result.conflict);
    this.persistSuccessLedger(
      prepared,
      result.output as unknown as JsonObject,
      result.activityId,
      result.revision
    );
    return result.output;
  }

  private async executeCommitPlan(
    prepared: PreparedInvocation
  ): Promise<OperationOutputMap[OperationName]> {
    if (!isTrustedHuman(prepared.principal, prepared.actor)) {
      throw new ForbiddenError('Only a trusted human may commit an approval card', {
        reason: 'approval_principal_required'
      });
    }
    const approvalId = this.requiredApprovalId(prepared.input);
    await this.materializeExpiredCard(approvalId, prepared);
    const snapshot = this.repository.read();
    const card = snapshot.approvalCards.get(approvalId);
    if (card === undefined) {
      throw new NotFoundError(`Approval card ${approvalId} was not found`, {
        reason: 'approval_not_found',
        approvalId
      });
    }
    if (card.status === 'expired' || this.cardExpired(card, this.repository.now())) {
      throw new ConflictError('The approval card has expired', {
        reason: 'plan_expired',
        approvalId
      });
    }
    if (card.status === 'rejected') {
      throw new ConflictError('The approval card was rejected', {
        reason: 'approval_rejected',
        approvalId
      });
    }
    if (card.status === 'committed') {
      throw new ConflictError('The approval card has already been committed', {
        reason: 'approval_required',
        approvalId
      });
    }
    if (card.status !== 'approved') {
      throw new ConflictError('An approved operation plan is required', {
        reason: 'approval_required',
        approvalId,
        retryAction: 'approve_operation_plan'
      });
    }

    const { targetName } = this.approvalTargetForCard(card);
    const targetHandler = this.handlers.get(targetName);
    if (targetHandler === undefined) {
      throw new InternalError(
        `Operation handler is not configured: ${targetName}`,
        { field: 'targetOperation' }
      );
    }

    const now = this.repository.now();
    const result = await this.repository.transactAsync(async (draft) => {
      this.assertAtomicRevision(prepared, draft.revision);
      const draftCard = draft.approvalCards.get(approvalId);
      if (draftCard === undefined) {
        throw new NotFoundError(`Approval card ${approvalId} was not found`, {
          reason: 'approval_not_found',
          approvalId
        });
      }
      if (this.cardExpired(draftCard, now)) {
        draftCard.status = 'expired';
        return conflictResult(
          new ConflictError('The approval card has expired', {
            reason: 'plan_expired',
            approvalId
          })
        );
      }
      if (draftCard.status === 'rejected') {
        throw new ConflictError('The approval card was rejected', {
          reason: 'approval_rejected',
          approvalId
        });
      }
      if (draftCard.status === 'committed') {
        throw new ConflictError('The approval card has already been committed', {
          reason: 'approval_required',
          approvalId
        });
      }
      if (draftCard.status !== 'approved') {
        throw new ConflictError('An approved operation plan is required', {
          reason: 'approval_required',
          approvalId,
          retryAction: 'approve_operation_plan'
        });
      }
      let draftTarget: {
        targetName: OperationName;
        targetInput: OperationInputMap[OperationName];
      };
      try {
        draftTarget = this.approvalTargetForCard(draftCard);
      } catch (error) {
        // A protected card with an invalidated target cannot be safely reused.
        if (error instanceof PipelineError) {
          draftCard.status = 'expired';
          return conflictResult(
            new ConflictError('The approval target changed after planning', {
              reason: 'entity_changed',
              approvalId,
              operationName: targetName
            })
          );
        }
        throw error;
      }
      if (draftTarget.targetName !== targetName) {
        draftCard.status = 'expired';
        return conflictResult(
          new ConflictError('The approval target changed after planning', {
            reason: 'entity_changed',
            approvalId,
            operationName: targetName
          })
        );
      }
      try {
        this.assertCardPolicyVersion(prepared, draftCard);
      } catch (error) {
        if (
          error instanceof ConflictError &&
          error.details?.reason === 'entity_changed'
        ) {
          draftCard.status = 'expired';
          return conflictResult(error);
        }
        throw error;
      }

      if (draft.revision < draftCard.baseRevision) {
        draftCard.status = 'expired';
        return conflictResult(
          new ConflictError('The approval plan has a stale base revision', {
            reason: 'stale_revision',
            expectedRevision: draftCard.baseRevision,
            currentRevision: draft.revision,
            approvalId
          })
        );
      }

      const draftTargetInput = draftTarget.targetInput;
      const draftFingerprint = createInvocationRequestFingerprint(
        draftTarget.targetName,
        draftTargetInput,
        draftCard.requestedBy
      );
      if (draftFingerprint !== draftCard.requestFingerprint) {
        draftCard.status = 'expired';
        return conflictResult(
          new ConflictError('The approval target changed after planning', {
            reason: 'entity_changed',
            approvalId,
            operationName: targetName
          })
        );
      }
      if (domainStateFingerprint(draft) !== draftCard.targetFingerprint) {
        draftCard.status = 'expired';
        return conflictResult(
          new ConflictError('The approval target changed after planning', {
            reason: 'entity_changed',
            approvalId,
            operationName: targetName
          })
        );
      }

      // Re-evaluate current target capability, resource scope, and consent
      // inside the same serialized transaction that runs the target handler.
      await this.authorizeTarget(
        prepared,
        targetName,
        draftTargetInput,
        'commit',
        { approvalId, status: 'approved', approvedBy: draftCard.approvedBy },
        {
          resourceScope: resourceScopeFor(targetName, draftTargetInput, prepared.principal),
          consent: consentForInput(draftTargetInput)
        }
      );

      const child = prepared.trace.startChild(`commit:${targetName}`);
      let targetOutput: OperationOutputMap[OperationName];
      try {
        const rawOutput = await targetHandler(
          deepClone(draftTargetInput),
          this.createHandlerContext(
            targetName,
            prepared.actor,
            draft,
            false,
            false,
            prepared
          )
        );
        targetOutput = serializeOutput(targetName, rawOutput);
        prepared.trace.completeSpan(child, 'completed');
      } catch (error) {
        prepared.trace.completeSpan(child, 'failed');
        throw error;
      }
      const safeTargetOutput = redactJsonObjectWithMetadata(targetOutput);
      draftCard.status = 'committed';
      draftCard.committedAt = now;
      const output = serializeOutput('commit_operation_plan', {
        approvalId,
        targetOperation: targetName,
        status: 'committed',
        output: safeTargetOutput.value,
        committedAt: now,
        ...(safeTargetOutput.redactions.length === 0
          ? {}
          : { redactions: safeTargetOutput.redactions })
      });
      prepared.trace.finish('completed');
      const activity = this.createActivityEntry(
        prepared.name,
        prepared.actor,
        activityInput(prepared.input),
        output as unknown as JsonObject,
        prepared,
        'commit',
        false,
        undefined,
        approvalId
      );
      draft.activityLog.push(activity);
      return { output, activityId: activity.id, revision: draft.revision + 1 };
    });

    if ('conflict' in result) throw PipelineError.from(result.conflict);
    this.persistSuccessLedger(
      prepared,
      result.output as unknown as JsonObject,
      result.activityId,
      result.revision
    );
    return result.output;
  }

  private requiredApprovalId(input: unknown): ApprovalId {
    if (
      !isPlainObject(input) ||
      typeof input.approvalId !== 'string' ||
      input.approvalId.trim().length === 0
    ) {
      throw new ValidationError('approvalId is required', {
        field: 'input.approvalId'
      });
    }
    return input.approvalId as ApprovalId;
  }

  private cardExpired(card: ApprovalCardRecord, now: Timestamp): boolean {
    const expiresAt = Date.parse(card.expiresAt);
    const nowMillis = Date.parse(now);
    return Number.isFinite(expiresAt) && Number.isFinite(nowMillis) && nowMillis >= expiresAt;
  }

  private async materializeExpiredCard(
    approvalId: ApprovalId,
    prepared: PreparedInvocation
  ): Promise<void> {
    const now = this.repository.now();
    const current = this.repository.read().approvalCards.get(approvalId);
    if (
      current === undefined ||
      !this.cardExpired(current, now) ||
      (current.status !== 'pending' && current.status !== 'approved')
    ) {
      return;
    }
    await this.repository.transactAsync((draft) => {
      this.assertAtomicRevision(prepared, draft.revision);
      const card = draft.approvalCards.get(approvalId);
      if (
        card !== undefined &&
        (card.status === 'pending' || card.status === 'approved') &&
        this.cardExpired(card, now)
      ) {
        card.status = 'expired';
      }
      return undefined;
    });
  }

  private assertExpectedRevision(
    prepared: PreparedInvocation,
    currentRevision: number
  ): void {
    const expectedRevision = prepared.metadata?.expectedRevision;
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
      throw new ConflictError(
        'The operation was based on a stale revision',
        detailsForRevision(expectedRevision, currentRevision, prepared.name)
      );
    }
  }

  private assertAtomicRevision(
    prepared: PreparedInvocation,
    draftRevision: number
  ): void {
    const currentRevision = this.repository.getRevision();
    if (currentRevision !== draftRevision) {
      throw new ConflictError('The repository changed during operation execution', {
        reason: 'stale_revision',
        expectedRevision: draftRevision,
        currentRevision,
        operationName: prepared.name
      });
    }
    this.assertExpectedRevision(prepared, draftRevision);
  }

  private createHandlerContext<N extends OperationName>(
    name: N,
    actor: ActorContext,
    state: SharedStateWithCatalogs,
    readOnly: boolean,
    preview: boolean,
    prepared: PreparedInvocation,
    idGenerator: IdGenerator = this.repository.idGenerator
  ): OperationHandlerContext<N> {
    const environment =
      prepared.invocationContext?.environment ?? this.environment;
    return {
      operationName: name,
      actor: deepClone(actor),
      state,
      readOnly,
      preview,
      ...(prepared.metadata === undefined
        ? {}
        : { metadata: deepClone(prepared.metadata) }),
      ...(prepared.principal === undefined
        ? {}
        : { principal: deepClone(prepared.principal) }),
      ...(this.authorizationPolicy === undefined
        ? {}
        : { authorizationPolicy: this.authorizationPolicy }),
      ...(environment === undefined ? {} : { environment }),
      trace: prepared.trace,
      clock: this.repository.clock,
      idGenerator,
      now: () => this.repository.now(),
      nextId: (prefix?: string) => idGenerator.next(prefix)
    };
  }

  private createActivityEntry(
    name: OperationName,
    actor: ActorContext,
    input: JsonObject,
    output: JsonObject,
    prepared: PreparedInvocation,
    phase: ActivityPhase,
    replayed = false,
    originalActivityId?: string,
    approvalId?: ApprovalId
  ): ActivityLogEntry {
    const entry: ActivityLogEntry = {
      id: this.repository.nextId('activity'),
      toolName: name,
      actorType: actor.actorType,
      actorId: actor.actorId,
      input: deepClone(input),
      output: deepClone(output),
      timestamp: this.repository.now(),
      correlationId: prepared.correlationId,
      traceId: prepared.trace.traceId,
      spanId: prepared.trace.rootSpanId,
      ...(prepared.trace.parentSpanId === undefined
        ? {}
        : { parentSpanId: prepared.trace.parentSpanId }),
      phase,
      ...(replayed ? { replayed: true } : {}),
      ...(originalActivityId === undefined ? {} : { originalActivityId }),
      ...(approvalId === undefined
        ? prepared.metadata?.approvalId === undefined
          ? {}
          : { approvalId: prepared.metadata.approvalId }
        : { approvalId }),
      trace: prepared.trace.snapshot()
    };
    // Historical three-argument callers retain the original six-field audit
    // shape. Sensitive public-prospect operations still use the shared
    // redactor even on that compatibility path. Every canonical envelope,
    // including one without optional transport metadata, gets the additive
    // safe trace projection.
    const requiresSensitiveOperationRedaction =
      name === 'import_public_prospect' ||
      name === 'revoke_public_prospect_consent';
    return prepared.legacy && !requiresSensitiveOperationRedaction
      ? {
          id: entry.id,
          toolName: entry.toolName,
          actorType: entry.actorType,
          actorId: entry.actorId,
          input: entry.input,
          output: entry.output,
          timestamp: entry.timestamp
        }
      : redactActivityEntry(entry);
  }

  private appendFailure(
    name: string,
    actor: ActorContext,
    input: JsonObject,
    error: PipelineError,
    correlationId: string,
    trace: OperationTraceContext,
    phase: ActivityPhase | undefined,
    approvalId?: ApprovalId,
    metadata?: InvocationMetadata,
    legacy = false
  ): { activityId: string; revision: number } {
    const prepared = {
      name: (name as OperationName),
      actor,
      correlationId,
      trace,
      ...(metadata === undefined && approvalId === undefined
        ? {}
        : {
            metadata: {
              ...(metadata ?? {}),
              ...(approvalId === undefined ? {} : { approvalId })
            }
          }),
      legacy,
      descriptor: { readOnly: false } as ReturnType<typeof getOperationDescriptor>
    } as PreparedInvocation;
    const activity = this.createActivityEntry(
      name as OperationName,
      actor,
      input,
      error.toPayload() as unknown as JsonObject,
      prepared,
      phase ?? 'commit',
      false,
      undefined,
      approvalId
    );
    const snapshot = this.repository.appendActivity(activity);
    return { activityId: activity.id, revision: snapshot.revision };
  }

  private persistSuccessLedger(
    prepared: PreparedInvocation,
    output: JsonObject,
    activityId: string,
    revision: number
  ): void {
    const ledgerContext = prepared.ledger;
    if (ledgerContext === undefined) return;
    const createdAt = this.repository.now();
    const entry: InvocationLedgerEntry = {
      scopeHash: ledgerContext.scopeHash,
      requestFingerprint: ledgerContext.requestFingerprint,
      operationName: prepared.name,
      status: 'success',
      responseOrError: cloneLedgerJson(output),
      originalActivityId: activityId,
      originalRevision: revision,
      correlationId: prepared.correlationId,
      traceId: prepared.trace.traceId,
      createdAt,
      expiresAt: expiryTimestamp(createdAt, this.idempotencyTtlMs)
    };
    this.repository.invocationLedger.set(ledgerContext.scopeHash, entry);
  }
}

export function createOperationService(
  options: OperationServiceOptions = {}
): OperationService {
  return new OperationService(options);
}

export const SharedOperationService = OperationService;
export type SharedOperationHandler<N extends OperationName = OperationName> =
  OperationHandler<N>;
export type SharedOperationHandlerMap = OperationHandlerMap;
export type SharedOperationBoundaryAdapter<
  N extends OperationName = OperationName
> = OperationBoundaryAdapter<N>;
export type SharedOperationBoundaryAdapterMap = OperationBoundaryAdapterMap;

/** Convenience helper for adapters that need a serializable error object. */
export function operationErrorObject(error: unknown) {
  return serializePipelineErrorObject(error);
}

export type { OperationInputMap, OperationName, OperationOutputMap };
