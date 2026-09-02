import type { DiscoverCapabilitiesOutput } from '../../shared/operations';
import {
  buildCapabilityManifest,
  createAuthorizationPolicy,
  createUnauthenticatedPrincipal
} from '../authorization';
import type { OperationHandler } from '../operationService';

/**
 * Return the canonical actor-scoped capability projection. The operation
 * context carries the exact policy instance owned by OperationService; the
 * fallback keeps legacy direct-handler callers fail-closed without treating
 * their audit actor as authenticated.
 */
export const discoverCapabilities: OperationHandler<'discover_capabilities'> = async (
  _input,
  context
): Promise<DiscoverCapabilitiesOutput> => {
  const principal =
    context.principal ?? createUnauthenticatedPrincipal('missing_principal');
  const policy =
    context.authorizationPolicy ??
    createAuthorizationPolicy({
      environment: context.environment ?? 'development'
    });

  return buildCapabilityManifest(principal, policy, {
    ...(context.environment === undefined
      ? {}
      : { environment: context.environment })
  });
};

export const discoverCapabilitiesHandler = discoverCapabilities;
export default discoverCapabilities;
