import { describe, expect, it } from 'vitest';
import {
  AUTHORIZATION_POLICY_VERSION,
  DemoActorResolver,
  ProductionActorResolver,
  createAuthorizationPolicy,
  createTrustedPrincipal,
  createUnauthenticatedPrincipal,
  resolveTrustedActor,
  type TrustedActorResolver
} from '../src/server/authorization';
import {
  actorContextFromHeaders,
  DEFAULT_HUMAN_ACTOR_CONTEXT,
  resolveTrustedActorContext
} from '../src/server/actorContext';

const development = { environment: 'development' as const };

function demoResolver(): DemoActorResolver {
  return new DemoActorResolver('development');
}

describe('trusted actor and authorization contracts', () => {
  it('keeps the non-production recruiter default while allowing only known demo identities', () => {
    const resolver = demoResolver();
    const defaultPrincipal = resolver.resolve(development);
    expect(defaultPrincipal.actor).toEqual(DEFAULT_HUMAN_ACTOR_CONTEXT);
    expect(defaultPrincipal.authenticationStatus).toBe('authenticated');
    expect(defaultPrincipal.roles).toEqual(['recruiter']);

    const candidate = resolver.resolve({
      ...development,
      headers: {
        'x-actor-type': 'human_ui',
        'x-actor-id': 'alice-candidate'
      }
    });
    expect(candidate.authenticationStatus).toBe('authenticated');
    expect(candidate.roles).toEqual(['candidate']);

    const unknown = resolver.resolve({
      ...development,
      headers: {
        'x-actor-type': 'human_ui',
        'x-actor-id': 'forged-user'
      }
    });
    expect(unknown.authenticationStatus).toBe('unauthenticated');
    expect(unknown.authenticated).toBe(false);
    expect(unknown.actor.actorId).toBe('unauthenticated');
  });

  it('does not promote arbitrary production headers and accepts only a host principal', async () => {
    const productionWithoutHost = new ProductionActorResolver();
    const rejected = await resolveTrustedActor(productionWithoutHost, {
      environment: 'production',
      headers: {
        'x-actor-type': 'human_ui',
        'x-actor-id': 'sarah-recruiter'
      }
    });
    expect(rejected.authenticationStatus).toBe('unauthenticated');
    expect(rejected.authenticationReason).toBe('missing_principal');

    let callbackSawHeaders = false;
    const production = new ProductionActorResolver(({ headers }) => {
      callbackSawHeaders = headers?.['x-actor-id'] === 'forged-user';
      return createTrustedPrincipal({
        actor: { actorType: 'human_ui', actorId: 'host-user-1' },
        roles: ['recruiter'],
        approvalCapabilities: ['workflow.plan.commit']
      });
    });
    const accepted = await resolveTrustedActor(production, {
      environment: 'production',
      headers: {
        'x-actor-type': 'human_ui',
        'x-actor-id': 'forged-user'
      }
    });
    expect(callbackSawHeaders).toBe(true);
    expect(accepted.actor.actorId).toBe('host-user-1');
    expect(accepted.authenticationStatus).toBe('authenticated');
    expect(accepted.source).toBe('trusted_host');

    const productionPolicy = createAuthorizationPolicy({ environment: 'production' });
    const demoPrincipal = demoResolver().resolve(development);
    const forgedProductionDecision = productionPolicy.decide({
      principal: demoPrincipal,
      operation: 'search_candidates'
    });
    expect(forgedProductionDecision.authenticated).toBe(false);
    expect(forgedProductionDecision.denialReason).toBe('not_authenticated');
  });

  it('keeps the legacy parser separate from trusted authentication', () => {
    expect(
      actorContextFromHeaders({
        'x-actor-type': 'agent',
        'x-actor-id': 'legacy-agent'
      })
    ).toEqual({ actorType: 'agent', actorId: 'legacy-agent' });
  });

  it('resolves an injected principal through the actor-context request adapter', async () => {
    const resolver: TrustedActorResolver = {
      resolve: () =>
        createTrustedPrincipal({
          actor: { actorType: 'human_ui', actorId: 'host-user-2' },
          roles: ['admin']
        })
    };
    const principal = await resolveTrustedActorContext(
      {
        headers: {
          'x-actor-id': 'not-authoritative'
        }
      },
      resolver,
      { environment: 'production' }
    );
    expect(principal.actor.actorId).toBe('host-user-2');
    expect(principal.roles).toEqual(['admin']);
  });

  it('evaluates authentication, capability, and candidate self-scope independently', () => {
    const policy = createAuthorizationPolicy({ environment: 'development' });
    const candidate = demoResolver().resolve({
      ...development,
      headers: {
        'x-actor-type': 'human_ui',
        'x-actor-id': 'alice-candidate'
      }
    });

    const ownProfile = policy.decide({
      principal: candidate,
      operation: 'get_candidate_profile',
      resourceScope: { resourceType: 'candidate', resourceIds: ['cand-1'] }
    });
    expect(ownProfile.allowed).toBe(true);
    expect(ownProfile.authenticated).toBe(true);
    expect(ownProfile.operationCapability.allowed).toBe(true);
    expect(ownProfile.resourceScope.allowed).toBe(true);
    expect(ownProfile.resourceScope.summary).toBe('candidate:self');

    const otherProfile = policy.decide({
      principal: candidate,
      operation: 'get_candidate_profile',
      resourceScope: { resourceType: 'candidate', resourceIds: ['cand-2'] }
    });
    expect(otherProfile.allowed).toBe(false);
    expect(otherProfile.resourceScope.allowed).toBe(false);
    expect(otherProfile.denialReason).toBe('resource_scope');
  });

  it('centralizes role capability and approval-principal decisions', () => {
    const policy = createAuthorizationPolicy();
    const agent = demoResolver().resolve({
      ...development,
      headers: {
        'x-actor-type': 'agent',
        'x-actor-id': 'agent-demo'
      }
    });
    const agentApproval = policy.decide({
      principal: agent,
      operation: 'approve_operation_plan'
    });
    expect(agentApproval.allowed).toBe(false);
    expect(agentApproval.approvalPrincipal.required).toBe(true);
    expect(agentApproval.approvalPrincipal.qualified).toBe(false);

    const recruiter = demoResolver().resolve(development);
    const recruiterApproval = policy.decide({
      principal: recruiter,
      operation: 'approve_operation_plan'
    });
    expect(recruiterApproval.allowed).toBe(true);
    expect(recruiterApproval.approvalPrincipal.satisfied).toBe(true);
  });

  it('requires both safe consent metadata and human approval for public prospect import', () => {
    const policy = createAuthorizationPolicy();
    const recruiter = demoResolver().resolve(development);
    const missingConsent = policy.decide({
      principal: recruiter,
      operation: 'import_public_prospect'
    });
    expect(missingConsent.allowed).toBe(false);
    expect(missingConsent.consent.required).toBe(true);
    expect(missingConsent.consent.satisfied).toBe(false);
    expect(missingConsent.denialReason).toBe('consent_required');

    const approved = policy.decide({
      principal: recruiter,
      operation: 'import_public_prospect',
      approval: { status: 'approved' },
      consent: {
        status: 'explicit',
        scope: 'candidate-profile',
        reference: 'consent-record-1',
        policyVersion: AUTHORIZATION_POLICY_VERSION
      }
    });
    expect(approved.allowed).toBe(true);
    expect(approved.consent.satisfied).toBe(true);
    expect(approved.approvalPrincipal.satisfied).toBe(true);
  });

  it('returns a safe structured error without policy internals or hidden IDs', () => {
    const policy = createAuthorizationPolicy();
    const unknown = createUnauthenticatedPrincipal('unknown_demo_actor');
    const decision = policy.decide({
      principal: unknown,
      operation: 'get_candidate_profile',
      resourceScope: { resourceType: 'candidate', resourceIds: ['hidden-candidate'] }
    });
    expect(decision.allowed).toBe(false);
    expect(decision.denialReason).toBe('not_authenticated');
    expect(decision.resourceScope.summary).toBe('candidate:requested');
    expect(JSON.stringify(decision)).not.toContain('hidden-candidate');
  });
});
