import { describe, expect, it } from 'vitest';
import {
  AUTHORIZATION_POLICY_VERSION,
  DemoActorResolver,
  createAuthorizationPolicy,
  createTrustedPrincipal
} from '../src/server/authorization';
import { OPERATION_REGISTRY } from '../src/shared/operations';

const development = { environment: 'development' as const };

function demoResolver(): DemoActorResolver {
  return new DemoActorResolver('development');
}

/**
 * An agent principal that is fully capable and scoped for the target
 * operation, so the ONLY control that can block it is the
 * agentDirectExecution:'forbidden' rule (not an incidental capability gap).
 */
function capableAgent() {
  return createTrustedPrincipal({
    actor: { actorType: 'agent', actorId: 'agent-capable' },
    roles: ['agent'],
    capabilities: [
      'pipeline.operation.send_offer',
      'pipeline.operation.respond_to_offer',
      'prospect.import',
      'workflow.plan'
    ],
    resourceScopes: [
      { resourceType: 'offer', mode: 'all' },
      { resourceType: 'application', mode: 'all' },
      { resourceType: 'prospect', mode: 'all' }
    ]
  });
}

describe('agent (LLM) safety: irreversible mutations require a human', () => {
  it('flags the irreversible operations as forbidden for direct agent execution', () => {
    expect(OPERATION_REGISTRY.send_offer.agentDirectExecution).toBe('forbidden');
    expect(OPERATION_REGISTRY.respond_to_offer.agentDirectExecution).toBe('forbidden');
    expect(OPERATION_REGISTRY.import_public_prospect.agentDirectExecution).toBe(
      'forbidden'
    );
  });

  it('blocks a capable agent from directly executing send_offer', () => {
    const policy = createAuthorizationPolicy();
    const decision = policy.decide({
      principal: capableAgent(),
      operation: 'send_offer',
      mode: 'commit',
      resourceScope: { resourceType: 'offer', resourceIds: ['offer-1'] }
    });
    expect(decision.allowed).toBe(false);
    expect(decision.denialReason).toBe('agent_execution_forbidden');
  });

  it('blocks a capable agent from directly executing respond_to_offer', () => {
    const policy = createAuthorizationPolicy();
    const decision = policy.decide({
      principal: capableAgent(),
      operation: 'respond_to_offer',
      mode: 'commit',
      resourceScope: { resourceType: 'offer', resourceIds: ['offer-1'] }
    });
    expect(decision.allowed).toBe(false);
    expect(decision.denialReason).toBe('agent_execution_forbidden');
  });

  it('does not apply the agent-execution block to a human recruiter sending an offer', () => {
    const policy = createAuthorizationPolicy();
    const recruiter = demoResolver().resolve(development);
    const decision = policy.decide({
      principal: recruiter,
      operation: 'send_offer',
      mode: 'commit',
      resourceScope: { resourceType: 'offer', resourceIds: ['offer-1'] }
    });
    // A human is never blocked by the agent-only rule (any other denial would
    // be an ordinary capability/scope decision, not this safety control).
    expect(decision.denialReason).not.toBe('agent_execution_forbidden');
    expect(decision.allowed).toBe(true);
  });

  it('does not apply the agent-execution block to a human candidate responding to an offer', () => {
    const policy = createAuthorizationPolicy();
    const candidate = demoResolver().resolve({
      ...development,
      headers: { 'x-actor-type': 'human_ui', 'x-actor-id': 'alice-candidate' }
    });
    const decision = policy.decide({
      principal: candidate,
      operation: 'respond_to_offer',
      mode: 'commit'
    });
    expect(decision.denialReason).not.toBe('agent_execution_forbidden');
  });

  it('allows the agent to reach the operation through the approved plan path', () => {
    const policy = createAuthorizationPolicy();
    // Once a human has approved the plan, the commit is no longer a direct
    // agent execution and the agent-execution guard does not fire.
    const decision = policy.decide({
      principal: capableAgent(),
      operation: 'import_public_prospect',
      mode: 'commit',
      approval: { status: 'approved' },
      consent: {
        status: 'explicit',
        scope: 'candidate-profile',
        reference: 'consent-record-1',
        policyVersion: AUTHORIZATION_POLICY_VERSION
      }
    });
    expect(decision.denialReason).not.toBe('agent_execution_forbidden');
  });

  it('never lets an agent approve or reject a plan (no self-approval)', () => {
    const policy = createAuthorizationPolicy();
    const agent = demoResolver().resolve({
      ...development,
      headers: { 'x-actor-type': 'agent', 'x-actor-id': 'agent-demo' }
    });

    const approve = policy.decide({
      principal: agent,
      operation: 'approve_operation_plan'
    });
    expect(approve.allowed).toBe(false);
    expect(approve.approvalPrincipal.required).toBe(true);
    expect(approve.approvalPrincipal.qualified).toBe(false);

    const reject = policy.decide({
      principal: agent,
      operation: 'reject_operation_plan'
    });
    expect(reject.allowed).toBe(false);
    expect(reject.approvalPrincipal.qualified).toBe(false);
  });
});
