export const STELLAR_INVOKE_SCOPE_LEGACY = 'stellar:invoke-contract';
export const STELLAR_INVOKE_SCOPE_WILDCARD = 'stellar:invoke-contract:*';

export type StellarInvocationAllowlistClass = 'anchoring';
export type StellarInvocationContractName =
  | 'confessionAnchor'
  | 'reputationBadges'
  | 'tippingSystem';

/**
 * User-facing intent that maps to exactly one contract operation. The intent is
 * what the wallet UI displays to the user; the operation is what actually gets
 * signed. Keeping the mapping explicit prevents a displayed intent from
 * silently authorizing a different contract call.
 */
export type StellarInvocationIntent =
  | 'anchor_confession'
  | 'anchor_confession_batch';

/**
 * Authorization footprint required by a single contract invocation. Every
 * entry describes one authorization requirement the signed invocation is
 * expected to carry. Any requirement not listed here is "unexpected" and must
 * be rejected before signing.
 */
export interface StellarInvocationAuthRequirement {
  /** Address whose authorization is required (e.g. the invoking account). */
  addressRole: 'invoker';
  /** Contract the authorization is granted to. */
  contractName: StellarInvocationContractName;
  /** Function on the contract the authorization covers. */
  functionName: string;
}

interface StellarInvocationPolicyDefinition {
  allowlistClass: StellarInvocationAllowlistClass;
  contractName: StellarInvocationContractName;
  functionName: string;
  /** Human-readable intent shown to the user before signing. */
  intent: StellarInvocationIntent;
  allowedScopes: readonly string[];
  issuedAdminScopes: readonly string[];
  /** Exact authorization footprint the signed invocation must carry. */
  requiredAuth: readonly StellarInvocationAuthRequirement[];
}

const STELLAR_INVOCATION_POLICY_DEFINITIONS = {
  anchor_confession: {
    allowlistClass: 'anchoring',
    contractName: 'confessionAnchor',
    functionName: 'anchor_confession',
    intent: 'anchor_confession',
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
    requiredAuth: [
      {
        addressRole: 'invoker',
        contractName: 'confessionAnchor',
        functionName: 'anchor_confession',
      },
    ],
  },
  anchor_confession_batch: {
    allowlistClass: 'anchoring',
    contractName: 'confessionAnchor',
    functionName: 'anchor_confession_batch',
    intent: 'anchor_confession_batch',
    allowedScopes: [
      STELLAR_INVOKE_SCOPE_WILDCARD,
      'stellar:invoke-contract:anchoring',
      'stellar:invoke-contract:anchor_confession_batch',
      STELLAR_INVOKE_SCOPE_LEGACY,
    ],
    issuedAdminScopes: [
      'stellar:invoke-contract:anchoring',
      'stellar:invoke-contract:anchor_confession_batch',
    ],
    requiredAuth: [
      {
        addressRole: 'invoker',
        contractName: 'confessionAnchor',
        functionName: 'anchor_confession_batch',
      },
    ],
  },
} as const satisfies Record<string, StellarInvocationPolicyDefinition>;

export type StellarInvocationOperation =
  keyof typeof STELLAR_INVOCATION_POLICY_DEFINITIONS;

export interface StellarInvocationPolicy
  extends StellarInvocationPolicyDefinition {
  operation: StellarInvocationOperation;
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
  };
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

/**
 * Resolve the operation that a user intent maps to. Returns null when the
 * intent is unknown so callers can fail closed instead of guessing.
 */
export function getStellarInvocationOperationForIntent(
  intent: string | undefined | null,
): StellarInvocationOperation | null {
  if (!intent) {
    return null;
  }

  for (const [operation, definition] of Object.entries(
    STELLAR_INVOCATION_POLICY_DEFINITIONS,
  )) {
    if (definition.intent === intent) {
      return operation as StellarInvocationOperation;
    }
  }

  return null;
}

export type StellarInvocationAuthRejectionReason =
  | 'unknown_operation'
  | 'unexpected_requirement'
  | 'missing_requirement'
  | 'mismatched_requirement';

export interface StellarInvocationAuthValidationResult {
  ok: boolean;
  reason?: StellarInvocationAuthRejectionReason;
  /** Human-readable detail for logs and error responses. */
  message?: string;
}

function authRequirementKey(
  requirement: StellarInvocationAuthRequirement,
): string {
  return [
    requirement.addressRole,
    requirement.contractName,
    requirement.functionName,
  ].join(':');
}

/**
 * Validate that the authorization footprint of a signed invocation exactly
 * matches the footprint declared for the operation. Extra (unexpected)
 * requirements, missing requirements, or requirements pointing at a different
 * contract/function are all rejected.
 */
export function validateStellarInvocationAuth(
  operation: string | undefined | null,
  requirements: readonly StellarInvocationAuthRequirement[] | undefined,
): StellarInvocationAuthValidationResult {
  const policy = getStellarInvocationPolicy(operation);
  if (!policy) {
    return {
      ok: false,
      reason: 'unknown_operation',
      message: `Unknown Stellar invocation operation: ${String(operation)}`,
    };
  }

  const actual = Array.isArray(requirements) ? requirements : [];
  const expectedKeys = new Set(policy.requiredAuth.map(authRequirementKey));
  const actualKeys = new Set(actual.map(authRequirementKey));

  for (const requirement of actual) {
    const key = authRequirementKey(requirement);
    if (!expectedKeys.has(key)) {
      const sameContract = policy.requiredAuth.some(
        (expected) =>
          expected.addressRole === requirement.addressRole &&
          expected.contractName === requirement.contractName,
      );
      return {
        ok: false,
        reason: sameContract ? 'mismatched_requirement' : 'unexpected_requirement',
        message: `Unexpected authorization requirement for ${policy.operation}: ${key}`,
      };
    }
  }

  for (const expected of policy.requiredAuth) {
    if (!actualKeys.has(authRequirementKey(expected))) {
      return {
        ok: false,
        reason: 'missing_requirement',
        message: `Missing authorization requirement for ${policy.operation}: ${authRequirementKey(
          expected,
        )}`,
      };
    }
  }

  return { ok: true };
}

/**
 * Assert that the intent displayed to the user resolves to the operation that
 * is about to be signed. Throws when they diverge so a mismatched intent can
 * never be signed.
 */
export function assertStellarInvocationIntentMatchesOperation(
  intent: string | undefined | null,
  operation: string | undefined | null,
): void {
  const resolved = getStellarInvocationOperationForIntent(intent);
  if (!resolved || resolved !== operation) {
    throw new Error(
      `Stellar invocation intent "${String(
        intent,
      )}" does not match operation "${String(operation)}"`,
    );
  }
}
