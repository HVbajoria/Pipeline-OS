import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_MANIFEST_VERSION,
  DemoActorResolver,
  buildCapabilityManifest,
  createAuthorizationPolicy,
  createUnauthenticatedPrincipal
} from '../src/server/authorization';
import { discoverCapabilities } from '../src/server/operations/discoverCapabilities';
import { defaultOperationHandlers } from '../src/server/operations';
import { OperationService } from '../src/server/operationService';
import {
  OPERATION_NAMES,
  OPERATION_REGISTRY,
  getOperationNames,
  type OperationName
} from '../src/shared/operations';
import { PipelineError } from '../src/shared/errors';
import { createTestContext } from './factories';

const resolver = new DemoActorResolver('test');
const policy = createAuthorizationPolicy({ environment: 'test' });

function demoPrincipal(
  actorType: 'human_ui' | 'agent',
  actorId: string
) {
  return resolver.resolve({
    environment: 'test',
    headers: {
      'x-actor-type': actorType,
      'x-actor-id': actorId
    }
  });
}

async function invokeManifest(principal: ReturnType<typeof demoPrincipal>) {
  const { repository } = createTestContext();
  const service = new OperationService({
    repository,
    handlers: defaultOperationHandlers,
    authorizationPolicy: policy,
    principal,
    environment: 'test'
  });
  return service.invoke(
    {
      name: 'discover_capabilities',
      input: {},
      actor: principal.actor
    },
    { principal, environment: 'test' }
  );
}

async function captureError<T>(promise: Promise<T>): Promise<PipelineError> {
  try {
    await promise;
  } catch (error) {
    return PipelineError.from(error);
  }
  throw new Error('Expected the operation to reject');
}

describe('P17 capability manifest discovery', () => {
  it('returns one bounded public entry for every canonical registry descriptor', async () => {
    const manifest = await invokeManifest(
      demoPrincipal('human_ui', 'sarah-recruiter')
    );

    expect(manifest.manifestVersion).toBe(CAPABILITY_MANIFEST_VERSION);
    expect(manifest.policyVersion).toBe('p11.2.v2');
    expect(manifest.actor).toEqual({
      actorType: 'human_ui',
      actorId: 'sarah-recruiter'
    });
    expect(manifest.capabilities.map((entry) => entry.name)).toEqual(
      getOperationNames()
    );
    expect(manifest.capabilities).toHaveLength(OPERATION_NAMES.length);

    for (const entry of manifest.capabilities) {
      const descriptor = OPERATION_REGISTRY[entry.name as OperationName];
      expect(descriptor).toBeDefined();
      expect(entry.description).toBe(descriptor.description);
      expect(entry.executionClass).toBe(descriptor.executionClass);
      expect(entry.readOnlyHint).toBe(descriptor.readOnlyHint);
      expect(entry.planable).toBe(descriptor.planable);
      expect(entry.requiredCapability).toBe(descriptor.requiredCapability);
      expect(entry.resourceScope.length).toBeLessThanOrEqual(160);
      expect(entry.schemaRef).toMatch(/^operation-registry:/);
      expect(entry.schemaRef!.length).toBeLessThanOrEqual(200);
      expect(entry.redactedFields.length).toBeLessThanOrEqual(30);
      expect(entry.redactedFields.every((field) => field.length <= 160)).toBe(
        true
      );
      expect(entry).not.toHaveProperty('implementationKey');
      expect(entry).not.toHaveProperty('inputSchema');
      expect(entry).not.toHaveProperty('outputSchema');
    }

    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain('implementationKey');
    expect(serialized).not.toContain('cand-1');
    expect(serialized).not.toContain('job-1');
    expect(serialized).not.toContain('approvalCapabilities');
  });

  it('uses trusted role and resource data to produce different safe subsets', async () => {
    const recruiter = await invokeManifest(
      demoPrincipal('human_ui', 'sarah-recruiter')
    );
    const candidate = await invokeManifest(
      demoPrincipal('human_ui', 'alice-candidate')
    );

    const recruiterSearch = recruiter.capabilities.find(
      (entry) => entry.name === 'search_candidates'
    )!;
    const candidateSearch = candidate.capabilities.find(
      (entry) => entry.name === 'search_candidates'
    )!;
    expect(recruiterSearch.visible).toBe(true);
    expect(recruiterSearch.allowed).toBe(true);
    expect(recruiterSearch.resourceScope).toBe('candidate:assigned');
    expect(candidateSearch.visible).toBe(false);
    expect(candidateSearch.allowed).toBe(false);
    expect(candidateSearch.denialReason).toBe('capability_denied');

    const recruiterProfile = recruiter.capabilities.find(
      (entry) => entry.name === 'get_candidate_profile'
    )!;
    const candidateProfile = candidate.capabilities.find(
      (entry) => entry.name === 'get_candidate_profile'
    )!;
    expect(recruiterProfile.allowed).toBe(true);
    expect(recruiterProfile.resourceScope).toBe('candidate:assigned');
    expect(candidateProfile.allowed).toBe(true);
    expect(candidateProfile.resourceScope).toBe('candidate:self');
    expect(recruiter.actor).not.toEqual(candidate.actor);
  });

  it('reports safe approval denial metadata for an agent without human approval rights', async () => {
    const manifest = await invokeManifest(demoPrincipal('agent', 'agent-demo'));
    const approval = manifest.capabilities.find(
      (entry) => entry.name === 'approve_operation_plan'
    )!;
    const commit = manifest.capabilities.find(
      (entry) => entry.name === 'commit_operation_plan'
    )!;

    expect(approval.visible).toBe(false);
    expect(approval.allowed).toBe(false);
    expect(approval.requiresApproval).toBe(true);
    expect(approval.denialReason).toBe('capability_denied');
    expect(commit.requiresApproval).toBe(true);
    expect(commit.allowed).toBe(false);
    expect(commit.denialReason).toBe('capability_denied');
    expect(JSON.stringify(approval)).not.toContain('approvalCapabilities');
  });

  it('fails closed for unknown or unauthenticated principals without hidden IDs', async () => {
    const unknown = createUnauthenticatedPrincipal('unknown_demo_actor');
    const manifest = await buildCapabilityManifest(unknown, policy, {
      environment: 'test'
    });

    expect(manifest.actor).toEqual({
      actorType: 'human_ui',
      actorId: 'unauthenticated'
    });
    expect(manifest.capabilities).toHaveLength(OPERATION_NAMES.length);
    expect(manifest.capabilities.every((entry) => entry.visible === false)).toBe(
      true
    );
    expect(manifest.capabilities.every((entry) => entry.allowed === false)).toBe(
      true
    );
    expect(
      manifest.capabilities.every(
        (entry) => entry.denialReason === 'actor_not_authenticated'
      )
    ).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain('cand-1');

    const { repository } = createTestContext();
    const service = new OperationService({
      repository,
      handlers: defaultOperationHandlers,
      authorizationPolicy: policy,
      principal: unknown,
      environment: 'test'
    });
    const error = await captureError(
      service.invoke(
        {
          name: 'discover_capabilities',
          input: {},
          actor: unknown.actor
        },
        { principal: unknown, environment: 'test' }
      )
    );
    expect(error.code).toBe('FORBIDDEN_ERROR');
    expect(error.status).toBe(403);
    expect(error.details?.reason).toBe('not_authenticated');
  });

  it('keeps handler registration and manifest ordering tied to the single registry', () => {
    expect(defaultOperationHandlers.discover_capabilities).toBe(
      discoverCapabilities
    );
    expect(Object.keys(OPERATION_REGISTRY)).toEqual([...OPERATION_NAMES]);
    expect(getOperationNames()).toEqual(Object.keys(OPERATION_REGISTRY));
  });
});
