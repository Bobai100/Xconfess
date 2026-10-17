export const STELLAR_INVOKE_SCOPE_LEGACY = 'stellar:invoke-contract';
export const STELLAR_INVOKE_SCOPE_WILDCARD = 'stellar:invoke-contract:*';

export type StellarInvocationAllowlistClass = 'anchoring' | 'saga';
export type StellarInvocationContractName =
  | 'confessionAnchor'
  | 'reputationBadges'
  | 'tippingSystem';

export type StellarInvocationSagaPhase = 'forward' | 'compensation';

interface StellarInvocationPolicyDefinition {
  allowlistClass: StellarInvocationAllowlistClass;
  contractName: StellarInvocationContractName;
  functionName: string;
  allowedScopes: readonly string[];
  issuedAdminScopes: readonly string[];
  /**
   * Saga phase this operation belongs to. Forward steps perform the primary
   * work; compensation steps reconcile or roll back a partially completed
   * multi-contract workflow. Defaults to 'forward' when omitted.
   */
  sagaPhase?: StellarInvocationSagaPhase;
  /**
   * For compensation operations, the forward operation this step compensates.
   * Used to validate that a saga definition pairs every forward step with an
   * authorized compensating action.
   */
  compensatesOperation?: StellarInvocationOperation;
}

const STELLAR_INVOCATION_POLICY_DEFINITIONS = {
  anchor_confession: {
    allowlistClass: 'anchoring',
    contractName: 'confessionAnchor',
    functionName: 'anchor_confession',
    allowedScopes: [
      STELLAR_INVOKE_SCOPE_WILDCARD,
      'stellar:invoke-contract:anchoring',
      'stellar:invoke-contract:anchor_confession',
      STELLAR_INVOKE_SCOPE_LEGACY,
    ],
    issuedAdminScopes: [
      'stellar:invoke-contract:anchoring',
      'stellar:invoke-contract:anchor_confession',
    ],
    sagaPhase: 'forward',
  },
  anchor_confession_compensation: {
    allowlistClass: 'saga',
    contractName: 'confessionAnchor',
    functionName: 'anchor_confession_compensation',
    allowedScopes: [
      STELLAR_INVOKE_SCOPE_WILDCARD,
      'stellar:invoke-contract:saga',
      'stellar:invoke-contract:anchor_confession_compensation',
      STELLAR_INVOKE_SCOPE_LEGACY,
    ],
    issuedAdminScopes: [
      'stellar:invoke-contract:saga',
      'stellar:invoke-contract:anchor_confession_compensation',
    ],
    sagaPhase: 'compensation',
    compensatesOperation: 'anchor_confession',
  },
  award_reputation_badge: {
    allowlistClass: 'saga',
    contractName: 'reputationBadges',
    functionName: 'award_reputation_badge',
    allowedScopes: [
      STELLAR_INVOKE_SCOPE_WILDCARD,
      'stellar:invoke-contract:saga',
      'stellar:invoke-contract:award_reputation_badge',
      STELLAR_INVOKE_SCOPE_LEGACY,
    ],
    issuedAdminScopes: [
      'stellar:invoke-contract:saga',
      'stellar:invoke-contract:award_reputation_badge',
    ],
    sagaPhase: 'forward',
  },
  revoke_reputation_badge: {
    allowlistClass: 'saga',
    contractName: 'reputationBadges',
    functionName: 'revoke_reputation_badge',
    allowedScopes: [
      STELLAR_INVOKE_SCOPE_WILDCARD,
      'stellar:invoke-contract:saga',
      'stellar:invoke-contract:revoke_reputation_badge',
      STELLAR_INVOKE_SCOPE_LEGACY,
    ],
    issuedAdminScopes: [
      'stellar:invoke-contract:saga',
      'stellar:invoke-contract:revoke_reputation_badge',
    ],
    sagaPhase: 'compensation',
    compensatesOperation: 'award_reputation_badge',
  },
  record_tip: {
    allowlistClass: 'saga',
    contractName: 'tippingSystem',
    functionName: 'record_tip',
    allowedScopes: [
      STELLAR_INVOKE_SCOPE_WILDCARD,
      'stellar:invoke-contract:saga',
      'stellar:invoke-contract:record_tip',
      STELLAR_INVOKE_SCOPE_LEGACY,
    ],
    issuedAdminScopes: [
      'stellar:invoke-contract:saga',
      'stellar:invoke-contract:record_tip',
    ],
    sagaPhase: 'forward',
  },
  reverse_tip: {
    allowlistClass: 'saga',
    contractName: 'tippingSystem',
    functionName: 'reverse_tip',
    allowedScopes: [
      STELLAR_INVOKE_SCOPE_WILDCARD,
      'stellar:invoke-contract:saga',
      'stellar:invoke-contract:reverse_tip',
      STELLAR_INVOKE_SCOPE_LEGACY,
    ],
    issuedAdminScopes: [
      'stellar:invoke-contract:saga',
      'stellar:invoke-contract:reverse_tip',
    ],
    sagaPhase: 'compensation',
    compensatesOperation: 'record_tip',
  },
} as const satisfies Record<string, StellarInvocationPolicyDefinition>;

export type StellarInvocationOperation =
  keyof typeof STELLAR_INVOCATION_POLICY_DEFINITIONS;

export interface StellarInvocationPolicy
  extends StellarInvocationPolicyDefinition {
  operation: StellarInvocationOperation;
  sagaPhase: StellarInvocationSagaPhase;
}

export const STELLAR_INVOKE_ALLOWED_OPERATIONS = Object.freeze(
  Object.keys(
    STELLAR_INVOCATION_POLICY_DEFINITIONS,
  ) as StellarInvocationOperation[],
);

export function getStellarInvocationPolicy(
  operation?: string | null,
): StellarInvocationPolicy | null {
  if (!operation) {
    return null;
  }

  const definition =
    STELLAR_INVOCATION_POLICY_DEFINITIONS[
      operation as StellarInvocationOperation
    ];

  if (!definition) {
    return null;
  }

  return {
    operation: operation as StellarInvocationOperation,
    ...definition,
    sagaPhase: definition.sagaPhase ?? 'forward',
  };
}

export function isStellarInvocationCompensation(
  operation?: string | null,
): boolean {
  return getStellarInvocationPolicy(operation)?.sagaPhase === 'compensation';
}

/**
 * Returns the compensation operation authorized to reconcile the given
 * forward operation, or null when no compensating action is defined.
 */
export function getStellarInvocationCompensationOperation(
  operation?: string | null,
): StellarInvocationOperation | null {
  if (!operation) {
    return null;
  }

  for (const [candidate, definition] of Object.entries(
    STELLAR_INVOCATION_POLICY_DEFINITIONS,
  ) as [StellarInvocationOperation, StellarInvocationPolicyDefinition][]) {
    if (definition.compensatesOperation === operation) {
      return candidate;
    }
  }

  return null;
}

/**
 * Returns the scopes required to authorize a saga step. Compensation steps
 * require their own explicit scope in addition to the shared saga scope, so a
 * caller holding only forward-step scopes cannot trigger reconciliation.
 */
export function getRequiredStellarInvocationScopes(
  operation?: string | null,
): string[] {
  const policy = getStellarInvocationPolicy(operation);
  if (!policy) {
    return [];
  }

  return [...policy.allowedScopes];
}

export function hasAnyStellarInvocationScope(
  scopes: readonly string[] | undefined,
): boolean {
  if (!Array.isArray(scopes)) {
    return false;
  }

  return scopes.some(
    (scope) =>
      scope === STELLAR_INVOKE_SCOPE_LEGACY ||
      scope === STELLAR_INVOKE_SCOPE_WILDCARD ||
      scope.startsWith(`${STELLAR_INVOKE_SCOPE_LEGACY}:`),
  );
}

export function getMatchingStellarInvocationScope(
  operation: string | undefined | null,
  scopes: readonly string[] | undefined,
): string | null {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return null;
  }

  const policy = getStellarInvocationPolicy(operation);
  if (policy) {
    return policy.allowedScopes.find((scope) => scopes.includes(scope)) ?? null;
  }

  return (
    scopes.find(
      (scope) =>
        scope === STELLAR_INVOKE_SCOPE_LEGACY ||
        scope === STELLAR_INVOKE_SCOPE_WILDCARD ||
        scope.startsWith(`${STELLAR_INVOKE_SCOPE_LEGACY}:`),
    ) ?? null
  );
}

export function getDefaultAdminStellarInvocationScopes(): string[] {
  const scopes = new Set<string>();

  for (const definition of Object.values(
    STELLAR_INVOCATION_POLICY_DEFINITIONS,
  )) {
    definition.issuedAdminScopes.forEach((scope) => scopes.add(scope));
  }

  return [...scopes];
}

export function getDefaultAdminStellarInvocationScopesForPhase(
  phase: StellarInvocationSagaPhase,
): string[] {
  const scopes = new Set<string>();

  for (const definition of Object.values(
    STELLAR_INVOCATION_POLICY_DEFINITIONS,
  )) {
    if ((definition.sagaPhase ?? 'forward') !== phase) {
      continue;
    }
    definition.issuedAdminScopes.forEach((scope) => scopes.add(scope));
  }

  return [...scopes];
}
