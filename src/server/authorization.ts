/**
 * Trusted-actor and centralized authorization contracts for the server boundary.
 *
 * This module deliberately stays independent from Express, the repository, and
 * operation handlers.  A host supplies a trusted principal in production; the
 * non-production demo resolver is the only place where presentation actor
 * headers are interpreted.  ActorContext remains the small, legacy-safe audit
 * shape while the principal below carries server-only authorization state.
 */

import type {
  ActorContext,
  ActorType,
  CapabilityDescriptor,
  CapabilityDenialReason,
  CapabilityManifest,
  OperationExecutionClass
} from '../shared/models';
import { assertActorContext } from '../shared/validators';
import type {
  OperationDescriptor,
  OperationName
} from '../shared/operations';
import {
  getOperationDescriptor,
  getOperationNames,
  isOperationName,
  MAX_CAPABILITIES
} from '../shared/operations';
import {
  ConflictError,
  ForbiddenError,
  type PipelineErrorDetails
} from '../shared/errors';
import type { ActorHeaders } from './actorContext';
import {
  actorContextFromHeaders,
  DEFAULT_HUMAN_ACTOR_CONTEXT,
  UNAUTHENTICATED_ACTOR_CONTEXT
} from './actorContext';

/** Bump when the server-side authorization semantics change. */
export const AUTHORIZATION_POLICY_VERSION = 'p11.2.v2';
export const DEFAULT_POLICY_VERSION = AUTHORIZATION_POLICY_VERSION;
/** Stable public version for the actor-scoped capability projection. */
export const CAPABILITY_MANIFEST_VERSION = 'p17.1.v2';

export const AUTHORIZATION_ROLES = [
  'recruiter',
  'candidate',
  'hiring_manager',
  'interviewer',
  'agent',
  'admin',
  'system'
] as const;
export type AuthorizationRole =
  | (typeof AUTHORIZATION_ROLES)[number]
  /** Compatibility spelling used by the human-facing role selector. */
  | 'hiring-manager';
export type PrincipalRole = AuthorizationRole;

export const AUTHENTICATION_STATUSES = [
  'authenticated',
  'unauthenticated',
  'unverified'
] as const;
export type AuthenticationStatus = (typeof AUTHENTICATION_STATUSES)[number];
export type AuthenticationState = AuthenticationStatus;

/** The environment controls whether presentation headers may be considered. */
export const AUTHORIZATION_ENVIRONMENTS = [
  'development',
  'test',
  'staging',
  'demo',
  'production'
] as const;
export type AuthorizationEnvironment =
  (typeof AUTHORIZATION_ENVIRONMENTS)[number];

export const RESOURCE_KINDS = [
  'job',
  'candidate',
  'application',
  'panel',
  'interview',
  'offer',
  'onboarding',
  'prospect',
  'approval',
  'workflow',
  'activity',
  'state',
  'event',
  'reset'
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export const RESOURCE_SCOPE_MODES = [
  'none',
  'self',
  'assigned',
  'delegated',
  'all'
] as const;
export type ResourceScopeMode = (typeof RESOURCE_SCOPE_MODES)[number];

export const AUTHENTICATION_FAILURE_REASONS = [
  'missing_principal',
  'unverified_principal',
  'invalid_principal',
  'unknown_demo_actor',
  'production_headers_ignored'
] as const;
export type AuthenticationFailureReason =
  (typeof AUTHENTICATION_FAILURE_REASONS)[number];

export type AuthorizationDenialReason =
  | 'not_authenticated'
  | 'capability_denied'
  | 'resource_scope'
  | 'approval_principal_required'
  | 'consent_required'
  | 'approval_only';

/**
 * Internal scope carried by a trusted principal.  IDs and tenant values never
 * belong in a public capability manifest; they are used only at the policy
 * boundary to answer an allow/deny question.
 */
export interface ResourceScope {
  resourceType: ResourceKind | '*';
  mode: ResourceScopeMode;
  resourceIds?: readonly string[];
  /** `ids` is an additive ergonomic alias for resourceIds. */
  ids?: readonly string[];
  subjectId?: string;
  tenantId?: string;
}

/** Scope requested by a validated operation or an adapter. */
export interface ResourceScopeRequirement {
  resourceType: ResourceKind | '*';
  mode?: ResourceScopeMode;
  resourceIds?: readonly string[];
  /** `ids` is accepted for callers that use the shorter internal spelling. */
  ids?: readonly string[];
  ownerId?: string;
  subjectId?: string;
  tenantId?: string;
}

export type ResourceScopeConstraint = ResourceScopeRequirement;

/** Non-operation HTTP resources that still require a trusted policy decision. */
export type AuthorizationRoute = 'state' | 'events' | 'reset';

export interface RouteAuthorizationRequest {
  principal: TrustedPrincipal;
  route: AuthorizationRoute;
  environment?: AuthorizationEnvironment;
}

export interface RouteCapabilityDecision {
  allowed: boolean;
  authenticated: boolean;
  route: AuthorizationRoute;
  requiredCapability: string;
  denialReason?: Extract<AuthorizationDenialReason, 'not_authenticated' | 'capability_denied'>;
  environment: AuthorizationEnvironment;
  policyVersion: string;
}

export type PrincipalSource =
  | 'demo'
  | 'trusted_session'
  | 'trusted_host'
  | 'unauthenticated';

/**
 * Server-only identity result.  `actor` is the legacy audit identity; the
 * remaining fields are trusted claims and must not be built from client input.
 */
export interface TrustedPrincipal {
  actor: ActorContext;
  authenticationStatus: AuthenticationStatus;
  authenticated: boolean;
  trusted: boolean;
  roles: readonly AuthorizationRole[];
  capabilities: readonly string[];
  resourceScopes: readonly ResourceScope[];
  /** Explicit capabilities usable as a human approval principal. */
  approvalCapabilities: readonly string[];
  /** Consent scopes granted by a trusted host, when applicable. */
  consentScopes: readonly string[];
  source: PrincipalSource;
  policyVersion: string;
  tenantId?: string;
  authenticationReason?: AuthenticationFailureReason;
}

export type ResolvedPrincipal = TrustedPrincipal;
export type Principal = TrustedPrincipal;

/** Input accepted by the production seam after the host has authenticated it. */
export interface TrustedPrincipalInput {
  actor: ActorContext;
  roles?: readonly AuthorizationRole[];
  /** A convenient singular role for host adapters. */
  role?: AuthorizationRole;
  authenticationStatus?: AuthenticationStatus;
  authenticated?: boolean;
  trusted?: boolean;
  capabilities?: readonly string[];
  resourceScopes?: readonly ResourceScope[];
  approvalCapabilities?: readonly string[];
  consentScopes?: readonly string[];
  source?: PrincipalSource;
  policyVersion?: string;
  tenantId?: string;
  authenticationReason?: AuthenticationFailureReason;
}

/**
 * Resolver input keeps the request/session opaque so this contract works with
 * Express, a worker, or an embedding host.  `headers` are explicitly
 * untrusted; only DemoActorResolver reads them, and only outside production.
 */
export interface TrustedActorResolutionInput {
  environment?: AuthorizationEnvironment;
  headers?: ActorHeaders;
  request?: unknown;
  trustedSession?: unknown;
  trustedPrincipal?: unknown;
}
export type ActorResolutionInput = TrustedActorResolutionInput;

export interface TrustedActorResolver {
  resolve(
    input: TrustedActorResolutionInput
  ): TrustedPrincipal | PromiseLike<TrustedPrincipal>;
}

export type ProductionTrustedPrincipalResolver = (
  input: TrustedActorResolutionInput
) => TrustedPrincipalInput | TrustedPrincipal | null | undefined | PromiseLike<
  TrustedPrincipalInput | TrustedPrincipal | null | undefined
>;

export interface ProductionActorResolverOptions {
  resolvePrincipal?: ProductionTrustedPrincipalResolver;
  resolveTrustedPrincipal?: ProductionTrustedPrincipalResolver;
}

export interface TrustedActorResolverFactoryOptions
  extends ProductionActorResolverOptions {
  environment?: AuthorizationEnvironment;
  productionResolver?: TrustedActorResolver | ProductionTrustedPrincipalResolver;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAuthorizationRole(value: unknown): value is AuthorizationRole {
  return (
    value === 'hiring-manager' ||
    (typeof value === 'string' &&
      (AUTHORIZATION_ROLES as readonly string[]).includes(value))
  );
}

function isAuthenticationStatus(value: unknown): value is AuthenticationStatus {
  return (
    typeof value === 'string' &&
    (AUTHENTICATION_STATUSES as readonly string[]).includes(value)
  );
}

function isResourceKind(value: unknown): value is ResourceKind | '*' {
  return (
    value === '*' ||
    (typeof value === 'string' &&
      (RESOURCE_KINDS as readonly string[]).includes(value))
  );
}

function isResourceScopeMode(value: unknown): value is ResourceScopeMode {
  return (
    typeof value === 'string' &&
    (RESOURCE_SCOPE_MODES as readonly string[]).includes(value)
  );
}

function uniqueStrings(values: readonly string[] | undefined, field: string): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) {
    throw new TypeError(`${field} must be an array`);
  }

  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new TypeError(`${field} must contain non-empty strings`);
    }
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

function normalizeResourceScopes(
  scopes: readonly ResourceScope[] | undefined
): ResourceScope[] {
  if (scopes === undefined) return [];
  if (!Array.isArray(scopes)) {
    throw new TypeError('resourceScopes must be an array');
  }

  return scopes.map((scope, index) => {
    const rawScope = scope as ResourceScope;
    if (!isResourceKind(rawScope.resourceType)) {
      throw new TypeError(`resourceScopes[${index}].resourceType is invalid`);
    }
    if (!isResourceScopeMode(rawScope.mode)) {
      throw new TypeError(`resourceScopes[${index}].mode is invalid`);
    }

    const resourceIds = uniqueStrings(
      rawScope.resourceIds ?? rawScope.ids,
      `resourceScopes[${index}].resourceIds`
    );
    const subjectId = rawScope.subjectId;
    const tenantId = rawScope.tenantId;
    if (subjectId !== undefined && (typeof subjectId !== 'string' || subjectId.trim() === '')) {
      throw new TypeError(`resourceScopes[${index}].subjectId is invalid`);
    }
    if (tenantId !== undefined && (typeof tenantId !== 'string' || tenantId.trim() === '')) {
      throw new TypeError(`resourceScopes[${index}].tenantId is invalid`);
    }

    return {
      resourceType: rawScope.resourceType,
      mode: rawScope.mode,
      ...(resourceIds.length > 0 ? { resourceIds } : {}),
      ...(subjectId !== undefined ? { subjectId } : {}),
      ...(tenantId !== undefined ? { tenantId } : {})
    };
  });
}

function normalizeRoles(input: TrustedPrincipalInput): AuthorizationRole[] {
  const values = [
    ...(input.roles ?? []),
    ...(input.role === undefined ? [] : [input.role])
  ];
  const result: AuthorizationRole[] = [];
  for (const value of values) {
    if (!isAuthorizationRole(value)) {
      throw new TypeError(`Unknown authorization role: ${String(value)}`);
    }
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

/** Build a validated principal for a trusted host adapter or a test seam. */
export function createTrustedPrincipal(input: TrustedPrincipalInput): TrustedPrincipal {
  const actor = assertActorContext(input.actor);
  const authenticationStatus = input.authenticationStatus ?? 'authenticated';
  if (!isAuthenticationStatus(authenticationStatus)) {
    throw new TypeError('authenticationStatus is invalid');
  }

  const authenticated =
    authenticationStatus === 'authenticated' && input.authenticated !== false;
  const trusted =
    authenticationStatus === 'authenticated' && input.trusted !== false;

  return {
    actor,
    authenticationStatus,
    authenticated,
    trusted,
    roles: normalizeRoles(input),
    capabilities: uniqueStrings(input.capabilities, 'capabilities'),
    resourceScopes: normalizeResourceScopes(input.resourceScopes),
    approvalCapabilities: uniqueStrings(
      input.approvalCapabilities,
      'approvalCapabilities'
    ),
    consentScopes: uniqueStrings(input.consentScopes, 'consentScopes'),
    source:
      input.source ??
      (authenticated ? 'trusted_session' : 'unauthenticated'),
    policyVersion: input.policyVersion ?? AUTHORIZATION_POLICY_VERSION,
    ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
    ...(input.authenticationReason === undefined
      ? {}
      : { authenticationReason: input.authenticationReason })
  };
}

/** Safe result used whenever authentication is absent, invalid, or untrusted. */
export function createUnauthenticatedPrincipal(
  reason: AuthenticationFailureReason = 'missing_principal'
): TrustedPrincipal {
  return createTrustedPrincipal({
    actor: UNAUTHENTICATED_ACTOR_CONTEXT,
    authenticationStatus: 'unauthenticated',
    authenticated: false,
    trusted: false,
    roles: [],
    capabilities: [],
    resourceScopes: [],
    approvalCapabilities: [],
    consentScopes: [],
    source: 'unauthenticated',
    authenticationReason: reason
  });
}

const RECRUITER_CAPABILITIES = [
  'pipeline.operation.*',
  'candidate.compare',
  'workflow.*',
  'interview.coordinate',
  'onboarding.coordinate',
  'prospect.*',
  'capabilities.discover',
  'state.read',
  'state.events',
  'state.reset'
] as const;

const CANDIDATE_CAPABILITIES = [
  'pipeline.operation.get_candidate_profile',
  'pipeline.operation.answer_candidate_faq',
  'pipeline.operation.submit_application',
  'pipeline.operation.respond_to_offer',
  'pipeline.operation.enroll_benefits',
  'pipeline.operation.get_onboarding_status',
  'workflow.status.read',
  'capabilities.discover',
  'state.read',
  'state.events'
] as const;

const HIRING_MANAGER_CAPABILITIES = [
  'pipeline.operation.search_candidates',
  'pipeline.operation.get_candidate_profile',
  'pipeline.operation.get_interview_kit',
  'pipeline.operation.get_panel_feedback_summary',
  'candidate.compare',
  'workflow.status.read',
  'interview.coordinate',
  'capabilities.discover',
  'state.read',
  'state.events'
] as const;

const INTERVIEWER_CAPABILITIES = [
  'pipeline.operation.get_candidate_profile',
  'pipeline.operation.get_interview_kit',
  'pipeline.operation.check_interviewer_availability',
  'pipeline.operation.propose_interview_slots',
  'pipeline.operation.book_interview',
  'pipeline.operation.submit_interview_feedback',
  'pipeline.operation.get_panel_feedback_summary',
  'interview.coordinate',
  'workflow.status.read',
  'state.read',
  'state.events',
  'capabilities.discover'
] as const;

/** Central role baseline. Agent rights are always explicit delegation only. */
export const ROLE_CAPABILITY_GRANTS: Readonly<
  Record<AuthorizationRole, readonly string[]>
> = {
  recruiter: RECRUITER_CAPABILITIES,
  candidate: CANDIDATE_CAPABILITIES,
  hiring_manager: HIRING_MANAGER_CAPABILITIES,
  'hiring-manager': HIRING_MANAGER_CAPABILITIES,
  interviewer: INTERVIEWER_CAPABILITIES,
  agent: [],
  admin: ['*'],
  system: ['*']
};

export const DEMO_ACTOR_IDS = {
  recruiter: 'sarah-recruiter',
  candidate: 'alice-candidate',
  hiringManager: 'morgan-hiring-manager',
  agent: 'agent-demo'
} as const;

const DEMO_AGENT_CAPABILITIES = [
  'pipeline.operation.search_candidates',
  'pipeline.operation.get_candidate_profile',
  'pipeline.operation.get_interview_kit',
  'pipeline.operation.get_onboarding_status',
  'prospect.search',
  'prospect.import',
  'candidate.compare',
  'workflow.status.read',
  'workflow.plan',
  'interview.coordinate',
  'onboarding.coordinate',
  'capabilities.discover',
  'state.read',
  'state.events'
] as const;

const DEMO_RECRUITER_SCOPES: readonly ResourceScope[] = [
  { resourceType: 'job', mode: 'assigned', resourceIds: ['job-1'] },
  {
    resourceType: 'candidate',
    mode: 'assigned',
    resourceIds: ['cand-1', 'cand-2', 'cand-3']
  },
  { resourceType: 'panel', mode: 'assigned', resourceIds: ['panel-1'] },
  { resourceType: 'application', mode: 'assigned' },
  { resourceType: 'offer', mode: 'assigned' },
  { resourceType: 'prospect', mode: 'all' }
];

const DEMO_CANDIDATE_SCOPES: readonly ResourceScope[] = [
  {
    resourceType: 'candidate',
    mode: 'self',
    resourceIds: ['cand-1'],
    subjectId: 'cand-1'
  },
  { resourceType: 'application', mode: 'self', subjectId: 'cand-1' },
  { resourceType: 'offer', mode: 'self', subjectId: 'cand-1' },
  { resourceType: 'onboarding', mode: 'self', subjectId: 'cand-1' }
];

const DEMO_HIRING_MANAGER_SCOPES: readonly ResourceScope[] = [
  { resourceType: 'job', mode: 'assigned', resourceIds: ['job-1'] },
  {
    resourceType: 'candidate',
    mode: 'assigned',
    resourceIds: ['cand-1', 'cand-2', 'cand-3']
  },
  { resourceType: 'application', mode: 'assigned' },
  { resourceType: 'panel', mode: 'assigned', resourceIds: ['panel-1'] }
];

export interface DemoActorDefinition {
  actor: ActorContext;
  roles: readonly AuthorizationRole[];
  capabilities?: readonly string[];
  resourceScopes: readonly ResourceScope[];
  approvalCapabilities?: readonly string[];
  consentScopes?: readonly string[];
}

/** Known presentation identities; arbitrary header values are not included. */
export const DEMO_ACTOR_DEFINITIONS: Readonly<
  Record<string, DemoActorDefinition>
> = {
  [`human_ui:${DEMO_ACTOR_IDS.recruiter}`]: {
    actor: { actorType: 'human_ui', actorId: DEMO_ACTOR_IDS.recruiter },
    roles: ['recruiter'],
    resourceScopes: DEMO_RECRUITER_SCOPES,
    approvalCapabilities: [
      'workflow.approval.approve',
      'workflow.approval.reject',
      'workflow.plan.commit'
    ]
  },
  [`human_ui:${DEMO_ACTOR_IDS.candidate}`]: {
    actor: { actorType: 'human_ui', actorId: DEMO_ACTOR_IDS.candidate },
    roles: ['candidate'],
    resourceScopes: DEMO_CANDIDATE_SCOPES
  },
  [`human_ui:${DEMO_ACTOR_IDS.hiringManager}`]: {
    actor: { actorType: 'human_ui', actorId: DEMO_ACTOR_IDS.hiringManager },
    roles: ['hiring_manager'],
    resourceScopes: DEMO_HIRING_MANAGER_SCOPES
  },
  [`agent:${DEMO_ACTOR_IDS.agent}`]: {
    actor: { actorType: 'agent', actorId: DEMO_ACTOR_IDS.agent },
    roles: ['agent'],
    capabilities: DEMO_AGENT_CAPABILITIES,
    resourceScopes: [
      { resourceType: 'job', mode: 'delegated', resourceIds: ['job-1'] },
      {
        resourceType: 'candidate',
        mode: 'delegated',
        resourceIds: ['cand-1', 'cand-2', 'cand-3']
      },
      { resourceType: 'application', mode: 'delegated' },
      { resourceType: 'offer', mode: 'delegated' },
      { resourceType: 'prospect', mode: 'delegated' }
    ]
  }
};

export const DEMO_KNOWN_ACTOR_IDS = Object.freeze(
  Object.values(DEMO_ACTOR_DEFINITIONS).map((definition) => definition.actor.actorId)
);

function principalFromDemoDefinition(
  definition: DemoActorDefinition
): TrustedPrincipal {
  return createTrustedPrincipal({
    actor: definition.actor,
    roles: definition.roles,
    capabilities: definition.capabilities,
    resourceScopes: definition.resourceScopes,
    approvalCapabilities: definition.approvalCapabilities,
    consentScopes: definition.consentScopes,
    source: 'demo',
    authenticationStatus: 'authenticated',
    authenticated: true,
    trusted: true
  });
}

function headersFromRequest(value: unknown): ActorHeaders | undefined {
  if (!isRecord(value) || !isRecord(value.headers)) return undefined;
  return value.headers as ActorHeaders;
}

function headersFromResolutionInput(
  input: TrustedActorResolutionInput
): ActorHeaders | undefined {
  return input.headers ?? headersFromRequest(input.request);
}

export function isProductionEnvironment(
  environment: AuthorizationEnvironment | undefined
): boolean {
  return environment === 'production';
}

/**
 * Non-production resolver for the existing demo UI.  Missing headers retain
 * the recruiter default; explicit unknown/malformed headers fail closed.
 */
export class DemoActorResolver implements TrustedActorResolver {
  constructor(
    private readonly defaultEnvironment: AuthorizationEnvironment = 'development'
  ) {}

  resolve(input: TrustedActorResolutionInput = {}): TrustedPrincipal {
    const environment = input.environment ?? this.defaultEnvironment;
    if (isProductionEnvironment(environment)) {
      return createUnauthenticatedPrincipal('production_headers_ignored');
    }

    try {
      const actor = actorContextFromHeaders(
        headersFromResolutionInput(input) ?? {}
      );
      const definition =
        DEMO_ACTOR_DEFINITIONS[`${actor.actorType}:${actor.actorId}`];
      if (definition === undefined) {
        return createUnauthenticatedPrincipal('unknown_demo_actor');
      }
      return principalFromDemoDefinition(definition);
    } catch {
      return createUnauthenticatedPrincipal('unknown_demo_actor');
    }
  }
}

export function createDemoActorResolver(
  environment: AuthorizationEnvironment = 'development'
): DemoActorResolver {
  return new DemoActorResolver(environment);
}

export interface ProductionTrustedActorResolutionInput
  extends TrustedActorResolutionInput {
  /** Production is forced regardless of the caller-provided environment. */
  environment: 'production';
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function normalizeProductionResult(
  value: TrustedPrincipalInput | TrustedPrincipal | null | undefined
): TrustedPrincipal {
  if (value === null || value === undefined) {
    return createUnauthenticatedPrincipal('missing_principal');
  }

  try {
    const principal = createTrustedPrincipal({
      ...(value as TrustedPrincipalInput),
      source: 'trusted_host'
    });
    if (
      principal.authenticationStatus !== 'authenticated' ||
      !principal.authenticated ||
      !principal.trusted
    ) {
      return createUnauthenticatedPrincipal('unverified_principal');
    }
    return principal;
  } catch {
    return createUnauthenticatedPrincipal('invalid_principal');
  }
}

/**
 * Production seam.  It never reads x-actor-type/x-actor-id.  Without a host
 * callback it intentionally returns an unauthenticated principal rather than
 * promoting an arbitrary request header to authentication.
 */
export class ProductionActorResolver implements TrustedActorResolver {
  private readonly resolvePrincipal?: ProductionTrustedPrincipalResolver;

  constructor(
    options:
      | ProductionActorResolverOptions
      | ProductionTrustedPrincipalResolver = {}
  ) {
    this.resolvePrincipal =
      typeof options === 'function'
        ? options
        : options.resolvePrincipal ?? options.resolveTrustedPrincipal;
  }

  resolve(input: TrustedActorResolutionInput = {}): TrustedPrincipal | PromiseLike<TrustedPrincipal> {
    if (this.resolvePrincipal === undefined) {
      return createUnauthenticatedPrincipal('missing_principal');
    }

    const productionInput: ProductionTrustedActorResolutionInput = {
      ...input,
      environment: 'production'
    };

    try {
      const result = this.resolvePrincipal(productionInput);
      if (isPromiseLike<TrustedPrincipalInput | TrustedPrincipal | null | undefined>(result)) {
        return result.then(normalizeProductionResult);
      }
      return normalizeProductionResult(result);
    } catch {
      return createUnauthenticatedPrincipal('invalid_principal');
    }
  }
}

export function createProductionActorResolver(
  options: ProductionActorResolverOptions | ProductionTrustedPrincipalResolver = {}
): ProductionActorResolver {
  return new ProductionActorResolver(options);
}

export function createTrustedActorResolver(
  options: TrustedActorResolverFactoryOptions = {}
): TrustedActorResolver {
  const environment = options.environment ?? 'development';
  if (!isProductionEnvironment(environment)) {
    return new DemoActorResolver(environment);
  }

  const productionResolver = options.productionResolver;
  if (productionResolver !== undefined) {
    if (typeof productionResolver === 'function') {
      return new ProductionActorResolver(productionResolver);
    }
    if (
      typeof productionResolver === 'object' &&
      productionResolver !== null &&
      typeof productionResolver.resolve === 'function'
    ) {
      return productionResolver;
    }
  }

  return new ProductionActorResolver(options);
}

export function resolveTrustedActor(
  resolver: TrustedActorResolver,
  input: TrustedActorResolutionInput = {}
): Promise<TrustedPrincipal> {
  return Promise.resolve(resolver.resolve(input));
}

export type AuthorizationMode = OperationExecutionClass | 'direct';

export interface ApprovalContext {
  approvalId?: string;
  status?: 'pending' | 'approved' | 'rejected' | 'expired' | 'committed';
  approvedBy?: ActorContext;
}

export type ConsentStatus =
  | 'missing'
  | 'explicit'
  | 'satisfied'
  | 'withdrawn'
  | 'expired'
  | 'unknown';

/** Safe consent metadata only; evidence contents never enter this contract. */
export interface ConsentContext {
  status?: ConsentStatus;
  scope?: string;
  policyVersion?: string;
  reference?: string;
  evidenceRef?: string;
}

export interface AuthorizationRequest<N extends OperationName = OperationName> {
  principal: TrustedPrincipal;
  operation?: N | OperationDescriptor<N>;
  /** Additive spelling for adapters that keep the descriptor separate. */
  operationName?: N;
  mode?: AuthorizationMode;
  executionClass?: OperationExecutionClass;
  resourceScope?: ResourceScopeRequirement;
  /** Additive alias for resourceScope. */
  resource?: ResourceScopeRequirement;
  approval?: ApprovalContext;
  consent?: ConsentContext;
  environment?: AuthorizationEnvironment;
}

export interface OperationCapabilityDecision {
  requiredCapability: string;
  granted: boolean;
  allowed: boolean;
  reason?: 'not_authenticated' | 'capability_denied';
}

export interface ResourceScopeDecision {
  required: boolean;
  allowed: boolean;
  summary: string;
  mode?: ResourceScopeMode;
  resourceType?: ResourceKind | '*';
  reason?: 'resource_scope' | 'not_authenticated';
}

export interface ApprovalPrincipalDecision {
  required: boolean;
  qualified: boolean;
  allowed: boolean;
  satisfied: boolean;
  requiredCapability?: string;
  reason?: 'approval_principal_required';
}

export interface ConsentDecision {
  required: boolean;
  satisfied: boolean;
  allowed: boolean;
  scope?: string;
  policyVersion?: string;
  reason?: 'consent_required';
}

export type OperationCapability = OperationCapabilityDecision;
export type ApprovalPrincipal = ApprovalPrincipalDecision;
export type ConsentRequirement = ConsentContext;

export interface AuthorizationModeDecision {
  requested: AuthorizationMode;
  allowed: boolean;
  requiresPlan: boolean;
}

/** Independent, safe-to-project result of one policy evaluation. */
export interface CapabilityDecision {
  allowed: boolean;
  authenticated: boolean;
  authenticationStatus: AuthenticationStatus;
  operationName?: OperationName;
  executionClass?: OperationExecutionClass;
  mode: AuthorizationMode;
  requiredCapability: string;
  operationCapability: OperationCapabilityDecision;
  /** `capability` is an additive alias for consumers using the shorter name. */
  capability: OperationCapabilityDecision;
  resourceScope: ResourceScopeDecision;
  /** `scope` is an additive alias for consumers using the shorter name. */
  scope: ResourceScopeDecision;
  approvalPrincipal: ApprovalPrincipalDecision;
  consent: ConsentDecision;
  modeDecision: AuthorizationModeDecision;
  requiresApproval: boolean;
  requiresPlan: boolean;
  denialReason?: AuthorizationDenialReason;
  /** Alias retained for policy clients that call the field `reason`. */
  reason?: AuthorizationDenialReason;
  environment: AuthorizationEnvironment;
  policyVersion: string;
}

export interface AuthorizationPolicy {
  readonly policyVersion?: string;
  decide(
    request: AuthorizationRequest
  ): CapabilityDecision | PromiseLike<CapabilityDecision>;
  /** Authorize non-operation state synchronization routes at the same boundary. */
  decideRoute?(
    request: RouteAuthorizationRequest
  ): RouteCapabilityDecision | PromiseLike<RouteCapabilityDecision>;
  evaluate?(
    request: AuthorizationRequest
  ): CapabilityDecision | PromiseLike<CapabilityDecision>;
  assertAllowed?(
    request: AuthorizationRequest
  ): void | PromiseLike<void>;
}

export interface CapabilityManifestBuildOptions {
  environment?: AuthorizationEnvironment;
  manifestVersion?: string;
}

/**
 * Resource metadata used only for a bounded discovery probe. It deliberately
 * contains no record IDs and mirrors the resource families enforced by the
 * operation service for inputs that can carry a concrete scope.
 */
function discoveryResourceType(name: OperationName): ResourceKind | undefined {
  switch (name) {
    case 'search_candidates':
    case 'search_public_candidates':
    case 'get_candidate_profile':
    case 'submit_application':
    case 'compare_candidates':
      return name === 'search_public_candidates' ? 'prospect' : 'candidate';
    case 'create_job_requisition':
    case 'answer_candidate_faq':
    case 'get_interview_kit':
      return 'job';
    case 'check_interviewer_availability':
      return 'panel';
    case 'propose_interview_slots':
    case 'book_interview':
    case 'get_panel_feedback_summary':
    case 'generate_offer':
    case 'coordinate_interview_workflow':
      return 'application';
    case 'submit_interview_feedback':
      return 'interview';
    case 'send_offer':
    case 'respond_to_offer':
    case 'initiate_background_check':
    case 'enroll_benefits':
    case 'generate_onboarding_checklist':
    case 'get_onboarding_status':
    case 'coordinate_onboarding_workflow':
      return 'offer';
    case 'get_approval_card':
    case 'approve_operation_plan':
    case 'reject_operation_plan':
    case 'commit_operation_plan':
      return 'approval';
    case 'import_public_prospect':
    case 'revoke_public_prospect_consent':
      return 'prospect';
    default:
      return undefined;
  }
}

function discoveryScopeMode(
  principal: TrustedPrincipal,
  resourceType: ResourceKind
): ResourceScopeMode {
  if (principal.roles.includes('admin') || principal.roles.includes('system')) {
    return 'all';
  }

  const modes = principal.resourceScopes
    .filter(
      (scope) =>
        scope.resourceType === resourceType || scope.resourceType === '*'
    )
    .map((scope) => scope.mode);
  for (const mode of ['all', 'assigned', 'delegated', 'self'] as const) {
    if (modes.includes(mode)) return mode;
  }
  return 'none';
}

function candidateFaqUsesOpenJobScope(
  name: OperationName,
  principal: TrustedPrincipal
): boolean {
  return name === 'answer_candidate_faq' && principal.roles.includes('candidate');
}

function discoveryResourceRequirement(
  name: OperationName,
  principal: TrustedPrincipal
): ResourceScopeRequirement | undefined {
  if (candidateFaqUsesOpenJobScope(name, principal)) return undefined;

  const resourceType = discoveryResourceType(name);
  if (resourceType === undefined) return undefined;

  // These collection operations have an explicit assigned-scope contract in
  // OperationService. Other resource-bearing operations are probed against a
  // mode the principal actually holds, without ever selecting an ID.
  const mode =
    name === 'create_job_requisition'
      ? ('assigned' as const)
      : discoveryScopeMode(principal, resourceType);
  if (mode !== 'self') return { resourceType, mode };

  // The existing self-scope matcher requires a subject or bounded ID to
  // establish that some self resource is available. Keep this claim inside
  // the policy request only; the public projection below contains the mode,
  // never the subject value.
  const selfScope = principal.resourceScopes.find(
    (scope) =>
      scope.mode === 'self' &&
      (scope.resourceType === resourceType || scope.resourceType === '*')
  );
  const subjectId =
    selfScope?.subjectId ??
    (selfScope?.resourceIds ?? selfScope?.ids ?? [])[0];
  return subjectId === undefined
    ? { resourceType, mode }
    : { resourceType, mode, subjectId };
}

function capabilityRedactions(name: OperationName): string[] {
  const redactions = new Set(['resourceIds', 'credentials']);
  switch (name) {
    case 'get_candidate_profile':
    case 'submit_application':
    case 'compare_candidates':
      redactions.add('privateContactFields');
      break;
    case 'search_public_candidates':
    case 'import_public_prospect':
    case 'revoke_public_prospect_consent':
      redactions.add('consentEvidence');
      redactions.add('upstreamPayload');
      break;
    case 'plan_operation':
    case 'get_approval_card':
    case 'approve_operation_plan':
    case 'reject_operation_plan':
    case 'commit_operation_plan':
      redactions.add('normalizedInput');
      redactions.add('requestFingerprint');
      break;
    default:
      break;
  }
  return [...redactions];
}

function publicDenialReason(
  decision: CapabilityDecision
): CapabilityDenialReason | undefined {
  const reason = decision.denialReason ?? decision.reason;
  switch (reason) {
    case 'not_authenticated':
      return 'actor_not_authenticated';
    case 'resource_scope':
      return 'resource_scope';
    case 'approval_only':
    case 'approval_principal_required':
    case 'consent_required':
      return 'approval_only';
    case 'capability_denied':
      return 'capability_denied';
    default:
      return decision.allowed ? undefined : 'capability_denied';
  }
}

function boundedManifestText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

/**
 * Evaluate every canonical descriptor through the supplied execution policy
 * and project only safe, bounded discovery data. This helper is informational;
 * OperationService still performs its own authorization before every handler.
 */
export async function buildCapabilityManifest(
  principal: TrustedPrincipal,
  policy: AuthorizationPolicy,
  options: CapabilityManifestBuildOptions = {}
): Promise<CapabilityManifest> {
  const operationNames = getOperationNames();
  if (operationNames.length > MAX_CAPABILITIES) {
    throw new Error('The operation registry exceeds the capability manifest limit');
  }

  const capabilities: CapabilityDescriptor[] = [];
  let evaluatedPolicyVersion: string | undefined;
  for (const name of operationNames) {
    const descriptor = getOperationDescriptor(name);
    const candidateOpenJobFaq = candidateFaqUsesOpenJobScope(name, principal);
    const resourceRequirement = candidateOpenJobFaq
      ? undefined
      : discoveryResourceRequirement(name, principal);
    const decision = await policy.decide({
      principal,
      operation: descriptor.name,
      mode: descriptor.executionClass,
      ...(resourceRequirement === undefined
        ? {}
        : { resourceScope: resourceRequirement }),
      ...(options.environment === undefined
        ? {}
        : { environment: options.environment })
    });
    evaluatedPolicyVersion ??= decision.policyVersion;
    const denialReason = publicDenialReason(decision);
    const resourceScope = candidateOpenJobFaq
      ? 'job:open'
      : resourceRequirement === undefined
        ? 'unrestricted'
        : `${resourceRequirement.resourceType}:${
            decision.resourceScope.allowed
              ? decision.resourceScope.mode ?? resourceRequirement.mode ?? 'requested'
              : resourceRequirement.mode ?? 'requested'
          }`;

    capabilities.push({
      name: boundedManifestText(descriptor.name, 100),
      description: boundedManifestText(descriptor.description, 500),
      // Public descriptors are safe to enumerate, while the visibility bit
      // identifies the subset for which this principal has capability and a
      // bounded resource scope. It never reveals a record ID.
      visible:
        decision.authenticated &&
        decision.operationCapability.allowed &&
        decision.resourceScope.allowed,
      allowed: decision.allowed,
      executionClass: descriptor.executionClass,
      readOnlyHint: descriptor.readOnlyHint,
      planable: descriptor.planable,
      requiresApproval:
        descriptor.approvalPolicy !== 'none' ||
        decision.requiresApproval ||
        decision.requiresPlan,
      requiredCapability: boundedManifestText(
        descriptor.requiredCapability,
        160
      ),
      resourceScope: boundedManifestText(resourceScope, 160),
      schemaRef: `operation-registry:${descriptor.name}`,
      redactedFields: capabilityRedactions(name),
      ...(denialReason === undefined ? {} : { denialReason })
    });
  }

  return {
    manifestVersion: boundedManifestText(
      options.manifestVersion ?? CAPABILITY_MANIFEST_VERSION,
      80
    ),
    policyVersion: boundedManifestText(
      evaluatedPolicyVersion ??
        policy.policyVersion ??
        principal.policyVersion ??
        AUTHORIZATION_POLICY_VERSION,
      80
    ),
    actor: {
      actorType: principal.actor.actorType,
      actorId: principal.actor.actorId
    },
    capabilities
  };
}

/** Additive descriptive alias for embedding hosts. */
export const createCapabilityManifest = buildCapabilityManifest;

export interface AuthorizationPolicyOptions {
  environment?: AuthorizationEnvironment;
  policyVersion?: string;
  roleCapabilities?: Partial<
    Record<AuthorizationRole, readonly string[]>
  >;
}

function capabilityMatches(granted: string, required: string): boolean {
  if (granted === '*' || granted === required) return true;
  if (granted.endsWith('*')) return required.startsWith(granted.slice(0, -1));
  return false;
}

function hasCapability(
  capabilities: readonly string[],
  requiredCapability: string
): boolean {
  return capabilities.some((granted) => capabilityMatches(granted, requiredCapability));
}

function idsForScope(scope: ResourceScope | ResourceScopeRequirement): readonly string[] {
  return scope.resourceIds ?? scope.ids ?? [];
}

function requiredScopeIds(
  scope: ResourceScopeRequirement
): readonly string[] {
  return scope.resourceIds ?? scope.ids ?? [];
}

function tenantMatches(
  principal: TrustedPrincipal,
  scope: ResourceScope | ResourceScopeRequirement
): boolean {
  const tenantId = scope.tenantId;
  return tenantId === undefined || tenantId === principal.tenantId;
}

function scopeMatches(
  principal: TrustedPrincipal,
  requirement: ResourceScopeRequirement
): { allowed: boolean; matchedMode?: ResourceScopeMode } {
  if (principal.roles.includes('admin') || principal.roles.includes('system')) {
    return { allowed: true, matchedMode: 'all' };
  }

  const requestedIds = requiredScopeIds(requirement);
  const scopes = principal.resourceScopes.filter(
    (scope) =>
      (scope.resourceType === requirement.resourceType || scope.resourceType === '*') &&
      tenantMatches(principal, scope) &&
      (requirement.tenantId === undefined ||
        scope.tenantId === requirement.tenantId)
  );

  for (const scope of scopes) {
    if (scope.mode === 'none') continue;
    if (scope.mode === 'all') return { allowed: true, matchedMode: 'all' };

    const allowedIds = idsForScope(scope);
    if (scope.mode === 'self') {
      const selfId = scope.subjectId;
      const ownerMatches =
        requirement.ownerId !== undefined &&
        (requirement.ownerId === selfId || requirement.ownerId === principal.actor.actorId);
      const subjectMatches =
        requirement.subjectId !== undefined &&
        (requirement.subjectId === selfId ||
          requirement.subjectId === principal.actor.actorId);
      const idsMatch =
        requestedIds.length > 0 &&
        (allowedIds.length === 0
          ? selfId !== undefined && requestedIds.every((id) => id === selfId)
          : requestedIds.every((id) => allowedIds.includes(id)));
      if (ownerMatches || subjectMatches || idsMatch) {
        return { allowed: true, matchedMode: 'self' };
      }
      continue;
    }

    if (requestedIds.length === 0) {
      // An assigned/delegated collection requirement is safe when the caller
      // has the same bounded assignment mode; no hidden ID is disclosed.
      if (requirement.mode === undefined || requirement.mode === scope.mode) {
        return { allowed: true, matchedMode: scope.mode };
      }
      continue;
    }

    if (
      requestedIds.length > 0 &&
      allowedIds.length === 0 &&
      (scope.mode === 'assigned' || scope.mode === 'delegated')
    ) {
      // An explicit assignment/delegation without an ID list is a bounded
      // collection claim. It permits concrete child IDs while keeping the
      // claim private; hosts that need a narrower boundary should provide
      // resourceIds instead.
      return { allowed: true, matchedMode: scope.mode };
    }

    if (
      allowedIds.length > 0 &&
      requestedIds.every((id) => allowedIds.includes(id))
    ) {
      return { allowed: true, matchedMode: scope.mode };
    }
  }

  return { allowed: false };
}

/**
 * Public server-side visibility primitive shared by state projection hosts.
 * It returns only a boolean and never exposes the principal's private scope
 * claims or the matched IDs.
 */
export function resourceScopeAllows(
  principal: TrustedPrincipal,
  requirement: ResourceScopeRequirement
): boolean {
  return scopeMatches(principal, requirement).allowed;
}

function safeScopeSummary(
  requirement: ResourceScopeRequirement | undefined,
  matchedMode?: ResourceScopeMode
): string {
  if (requirement === undefined) return 'unrestricted';
  return `${requirement.resourceType}:${matchedMode ?? requirement.mode ?? 'requested'}`;
}

function descriptorForRequest(
  request: AuthorizationRequest
): { name?: OperationName; descriptor?: OperationDescriptor } {
  const operation = request.operation;
  if (typeof operation === 'string') {
    return isOperationName(operation)
      ? { name: operation, descriptor: getOperationDescriptor(operation) }
      : {};
  }
  if (operation !== undefined && isRecord(operation) && isOperationName(operation.name)) {
    return {
      name: operation.name,
      descriptor: operation as OperationDescriptor
    };
  }
  if (request.operationName !== undefined && isOperationName(request.operationName)) {
    return {
      name: request.operationName,
      descriptor: getOperationDescriptor(request.operationName)
    };
  }
  return {};
}

function modeForRequest(
  request: AuthorizationRequest,
  descriptor: OperationDescriptor | undefined
): AuthorizationMode {
  const requested = request.mode ?? request.executionClass ?? descriptor?.executionClass ?? 'read';
  return requested === 'direct' ? 'commit' : requested;
}

function isTrustedHuman(principal: TrustedPrincipal): boolean {
  return (
    principal.authenticated &&
    principal.trusted &&
    principal.authenticationStatus === 'authenticated' &&
    principal.actor.actorType === 'human_ui'
  );
}

function consentSatisfied(
  consent: ConsentContext | undefined,
  principal: TrustedPrincipal,
  requiredPolicyVersion: string
): boolean {
  if (consent === undefined) return false;
  const status = consent.status ?? 'unknown';
  if (status !== 'explicit' && status !== 'satisfied') return false;
  if (consent.scope === undefined || consent.scope.trim().length === 0) return false;
  if (
    consent.policyVersion !== undefined &&
    consent.policyVersion !== requiredPolicyVersion
  ) {
    return false;
  }
  const reference = consent.reference ?? consent.evidenceRef;
  if (reference === undefined || reference.trim().length === 0) return false;
  return (
    principal.consentScopes.length === 0 ||
    principal.consentScopes.includes(consent.scope)
  );
}

function approvalCapabilityFor(
  name: OperationName | undefined,
  descriptor: OperationDescriptor | undefined
): string | undefined {
  if (name === undefined || descriptor === undefined) return undefined;
  if (name === 'approve_operation_plan' || name === 'reject_operation_plan') {
    return descriptor.requiredCapability;
  }
  return 'workflow.plan.commit';
}

function requiresHumanApproval(
  name: OperationName | undefined,
  descriptor: OperationDescriptor | undefined,
  mode: AuthorizationMode
): boolean {
  if (name === 'approve_operation_plan' || name === 'reject_operation_plan') {
    return true;
  }
  if (name === 'commit_operation_plan') return true;
  return (
    mode === 'commit' &&
    (descriptor?.approvalPolicy === 'human' ||
      descriptor?.approvalPolicy === 'consent_and_human')
  );
}

function requiresConsent(descriptor: OperationDescriptor | undefined): boolean {
  return descriptor?.approvalPolicy === 'consent_and_human';
}

function createDecision(
  request: AuthorizationRequest,
  policyVersion: string,
  roleCapabilities: Readonly<
    Record<AuthorizationRole, readonly string[]>
  > = ROLE_CAPABILITY_GRANTS,
  environment: AuthorizationEnvironment = 'development'
): CapabilityDecision {
  const { name, descriptor } = descriptorForRequest(request);
  const principal = request.principal;
  const mode = modeForRequest(request, descriptor);
  const requiredCapability = descriptor?.requiredCapability ?? 'unknown';
  const authenticated =
    principal.authenticationStatus === 'authenticated' &&
    principal.authenticated &&
    principal.trusted &&
    !(isProductionEnvironment(environment) && principal.source === 'demo');

  const operationAllowed =
    authenticated &&
    descriptor !== undefined &&
    hasCapability(
      principalCapabilitiesWithRoleMap(principal, roleCapabilities),
      requiredCapability
    );
  const operationCapability: OperationCapabilityDecision = {
    requiredCapability,
    granted: operationAllowed,
    allowed: operationAllowed,
    ...(!authenticated
      ? { reason: 'not_authenticated' as const }
      : operationAllowed
        ? {}
        : { reason: 'capability_denied' as const })
  };

  const requestedScope = request.resourceScope ?? request.resource;
  const matchedScope =
    requestedScope === undefined
      ? { allowed: true }
      : scopeMatches(principal, requestedScope);
  const resourceScope: ResourceScopeDecision = {
    required: requestedScope !== undefined,
    allowed: matchedScope.allowed,
    summary: safeScopeSummary(requestedScope, matchedScope.matchedMode),
    ...(requestedScope === undefined
      ? {}
      : {
          resourceType: requestedScope.resourceType,
          ...(matchedScope.matchedMode === undefined
            ? {}
            : { mode: matchedScope.matchedMode })
        }),
    ...(!matchedScope.allowed
      ? {
          reason: authenticated
            ? ('resource_scope' as const)
            : ('not_authenticated' as const)
        }
      : {})
  };

  const approvalRequired = requiresHumanApproval(name, descriptor, mode);
  const approvalCapability = approvalCapabilityFor(name, descriptor);
  const qualifiedApprovalPrincipal =
    !approvalRequired ||
    (isTrustedHuman(principal) &&
      approvalCapability !== undefined &&
      hasCapability(principal.approvalCapabilities, approvalCapability));
  const approvalStatusSatisfied =
    name === 'approve_operation_plan' || name === 'reject_operation_plan'
      ? qualifiedApprovalPrincipal
      : !approvalRequired ||
          (mode === 'commit' && descriptor?.planable !== true)
        ? qualifiedApprovalPrincipal
        : request.approval?.status === 'approved';
  const approvalPrincipal: ApprovalPrincipalDecision = {
    required: approvalRequired,
    qualified: qualifiedApprovalPrincipal,
    allowed: qualifiedApprovalPrincipal,
    satisfied: qualifiedApprovalPrincipal && approvalStatusSatisfied,
    ...(approvalCapability === undefined
      ? {}
      : { requiredCapability: approvalCapability }),
    ...(approvalRequired && !qualifiedApprovalPrincipal
      ? { reason: 'approval_principal_required' as const }
      : {})
  };

  const consentRequired = requiresConsent(descriptor);
  const consentIsSatisfied =
    !consentRequired ||
    consentSatisfied(request.consent, principal, policyVersion);
  const consent: ConsentDecision = {
    required: consentRequired,
    satisfied: consentIsSatisfied,
    allowed: consentIsSatisfied,
    ...(request.consent?.scope === undefined
      ? {}
      : { scope: request.consent.scope }),
    ...(request.consent?.policyVersion === undefined
      ? {}
      : { policyVersion: request.consent.policyVersion }),
    ...(consentRequired && !consentIsSatisfied
      ? { reason: 'consent_required' as const }
      : {})
  };

  const modeAllowed =
    descriptor !== undefined &&
    (mode === descriptor.executionClass ||
      (mode === 'commit' && descriptor.executionClass === 'commit') ||
      (mode === 'plan' && descriptor.planable) ||
      (mode === 'approval' && descriptor.executionClass === 'approval'));
  const requiresPlan =
    mode === 'commit' &&
    descriptor?.planable === true &&
    (principal.actor.actorType === 'agent' || descriptor.approvalPolicy !== 'none') &&
    request.approval?.status !== 'approved';
  const modeDecision: AuthorizationModeDecision = {
    requested: request.mode ?? request.executionClass ?? mode,
    allowed: modeAllowed,
    requiresPlan
  };

  let denialReason: AuthorizationDenialReason | undefined;
  if (!authenticated) denialReason = 'not_authenticated';
  else if (!operationAllowed) denialReason = 'capability_denied';
  else if (!resourceScope.allowed) denialReason = 'resource_scope';
  else if (!modeAllowed) denialReason = 'capability_denied';
  else if (!consentIsSatisfied) denialReason = 'consent_required';
  else if (approvalRequired && !qualifiedApprovalPrincipal) {
    denialReason = 'approval_principal_required';
  } else if (requiresPlan || (approvalRequired && !approvalStatusSatisfied)) {
    denialReason = 'approval_only';
  }

  const decision: CapabilityDecision = {
    allowed: denialReason === undefined,
    authenticated,
    authenticationStatus: principal.authenticationStatus,
    ...(name === undefined ? {} : { operationName: name }),
    ...(descriptor?.executionClass === undefined
      ? {}
      : { executionClass: descriptor.executionClass }),
    mode,
    requiredCapability,
    operationCapability,
    capability: operationCapability,
    resourceScope,
    scope: resourceScope,
    approvalPrincipal,
    consent,
    modeDecision,
    requiresApproval: approvalRequired,
    requiresPlan,
    ...(denialReason === undefined ? {} : { denialReason, reason: denialReason }),
    environment,
    policyVersion
  };

  return decision;
}

/** Default centralized policy used by composition roots that do not override it. */
export class DefaultAuthorizationPolicy implements AuthorizationPolicy {
  readonly policyVersion: string;
  readonly environment: AuthorizationEnvironment;
  private readonly roleCapabilities: Readonly<
    Record<AuthorizationRole, readonly string[]>
  >;

  constructor(options: AuthorizationPolicyOptions = {}) {
    this.policyVersion = options.policyVersion ?? AUTHORIZATION_POLICY_VERSION;
    this.environment = options.environment ?? 'development';
    this.roleCapabilities = {
      ...ROLE_CAPABILITY_GRANTS,
      ...(options.roleCapabilities ?? {})
    };
  }

  decide(request: AuthorizationRequest): CapabilityDecision {
    const environment =
      this.environment === 'production'
        ? 'production'
        : request.environment ?? this.environment;
    return createDecision(
      request,
      this.policyVersion,
      this.roleCapabilities,
      environment
    );
  }

  decideRoute(request: RouteAuthorizationRequest): RouteCapabilityDecision {
    const environment =
      this.environment === 'production'
        ? 'production'
        : request.environment ?? this.environment;
    const requiredCapability =
      request.route === 'state'
        ? 'state.read'
        : request.route === 'events'
          ? 'state.events'
          : 'state.reset';
    const principal = request.principal;
    const authenticated =
      principal.authenticationStatus === 'authenticated' &&
      principal.authenticated &&
      principal.trusted &&
      !(isProductionEnvironment(environment) && principal.source === 'demo');
    const allowed =
      authenticated &&
      hasCapability(
        principalCapabilitiesWithRoleMap(principal, this.roleCapabilities),
        requiredCapability
      );
    return {
      allowed,
      authenticated,
      route: request.route,
      requiredCapability,
      ...(allowed
        ? {}
        : {
            denialReason: authenticated
              ? ('capability_denied' as const)
              : ('not_authenticated' as const)
          }),
      environment,
      policyVersion: this.policyVersion
    };
  }

  evaluate(request: AuthorizationRequest): CapabilityDecision {
    return this.decide(request);
  }

  assertAllowed(request: AuthorizationRequest): void {
    const decision = this.decide(request);
    if (!decision.allowed) throw authorizationDecisionError(decision);
  }
}

function principalCapabilitiesWithRoleMap(
  principal: TrustedPrincipal,
  roleCapabilities: Readonly<Record<AuthorizationRole, readonly string[]>>
): string[] {
  const result = [...principal.capabilities];
  for (const role of principal.roles) {
    for (const capability of roleCapabilities[role] ?? []) {
      if (!result.includes(capability)) result.push(capability);
    }
  }
  return result;
}

export function createAuthorizationPolicy(
  options: AuthorizationPolicyOptions = {}
): DefaultAuthorizationPolicy {
  return new DefaultAuthorizationPolicy(options);
}

export function authorizationDecisionError(
  decision: CapabilityDecision
): ForbiddenError | ConflictError {
  const details: PipelineErrorDetails = {
    ...(decision.operationName === undefined
      ? {}
      : { operationName: decision.operationName }),
    ...(decision.requiredCapability === 'unknown'
      ? {}
      : { requiredCapability: decision.requiredCapability }),
    ...(decision.resourceScope.summary === 'unrestricted'
      ? {}
      : { resourceScope: decision.resourceScope.summary })
  };

  if (
    decision.denialReason === 'approval_only' ||
    decision.requiresPlan
  ) {
    return new ConflictError('An approved operation plan is required', {
      ...details,
      reason: 'approval_required',
      retryAction: 'plan_operation'
    });
  }

  const reason =
    decision.denialReason === 'approval_principal_required' ||
    decision.denialReason === 'consent_required' ||
    decision.denialReason === 'resource_scope' ||
    decision.denialReason === 'not_authenticated'
      ? decision.denialReason
      : 'capability_denied';
  return new ForbiddenError('You do not have permission to perform this action', {
    ...details,
    reason
  });
}

export function authorizationRouteDecisionError(
  decision: RouteCapabilityDecision
): ForbiddenError {
  return new ForbiddenError('You do not have permission to perform this action', {
    reason: decision.denialReason ?? 'capability_denied',
    requiredCapability: decision.requiredCapability,
    resourceScope: decision.route
  });
}

export function assertAuthorizationAllowed(
  policy: AuthorizationPolicy,
  request: AuthorizationRequest
): void | PromiseLike<void> {
  if (typeof policy.assertAllowed === 'function') {
    return policy.assertAllowed(request);
  }
  const result = policy.decide(request);
  if (isPromiseLike<CapabilityDecision>(result)) {
    return result.then((decision) => {
      if (!decision.allowed) throw authorizationDecisionError(decision);
    });
  }
  if (!result.allowed) throw authorizationDecisionError(result);
}

export const AuthorizationService = DefaultAuthorizationPolicy;
export const DemoTrustedActorResolver = DemoActorResolver;
export const ProductionTrustedActorResolver = ProductionActorResolver;
