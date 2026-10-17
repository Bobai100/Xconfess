import {
  AuditActor,
  AuditLogContext,
} from '../audit-log/audit-log.service';
import { RequestUser } from '../auth/interfaces/jwt-payload.interface';

export type StellarInvocationOutcome =
  | 'success'
  | 'failed'
  | 'denied'
  | 'partial';

export type StellarCompensatingAction =
  | 'none'
  | 'compensated'
  | 'compensation_failed'
  | 'reconciliation_required'
  | 'skipped';

interface StellarAuditRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  user?: RequestUser;
  requestId?: string;
}

interface BuildStellarInvocationAuditMetadataOptions {
  operation?: string | null;
  allowlistClass?: string | null;
  contractId?: string | null;
  functionName?: string | null;
  sourceAccount?: string | null;
  outcome: StellarInvocationOutcome;
  denialReason?: string | null;
  transactionHash?: string | null;
  chainSuccess?: boolean | null;
  errorMessage?: string | null;
  expectedSourceAccount?: string | null;
  authorizedScope?: string | null;
  requiredScopes?: readonly string[] | null;
  sagaId?: string | null;
  stepIndex?: number | null;
  totalSteps?: number | null;
  compensatingAction?: StellarCompensatingAction | null;
  partialState?: Record<string, unknown> | null;
}

function createAdminActor(user?: RequestUser): AuditActor | undefined {
  if (!user) {
    return undefined;
  }

  return {
    type: 'admin',
    id: String(user.id),
    userId: String(user.id),
    label: user.username,
  };
}

export function buildAuditContextFromRequest(
  request: StellarAuditRequest,
): AuditLogContext {
  const userAgentHeader = request.headers['user-agent'];
  const userAgent =
    typeof userAgentHeader === 'string' ? userAgentHeader : undefined;

  return {
    userId: request.user?.id,
    actor: createAdminActor(request.user),
    ipAddress: request.ip,
    userAgent,
    requestId: request.requestId,
  };
}

export function buildStellarInvocationAuditMetadata(
  options: BuildStellarInvocationAuditMetadataOptions,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    entityType: 'stellar_invocation',
    entityId: options.operation || 'unknown',
    stellarOperation: options.operation || 'unknown',
    outcome: options.outcome,
  };

  if (options.allowlistClass) {
    metadata.allowlistClass = options.allowlistClass;
  }

  if (options.contractId) {
    metadata.contractId = options.contractId;
  }

  if (options.functionName) {
    metadata.functionName = options.functionName;
  }

  if (options.sourceAccount) {
    metadata.sourceAccount = options.sourceAccount;
  }

  if (options.denialReason) {
    metadata.denialReason = options.denialReason;
  }

  if (options.transactionHash) {
    metadata.transactionHash = options.transactionHash;
  }

  if (typeof options.chainSuccess === 'boolean') {
    metadata.chainSuccess = options.chainSuccess;
  }

  if (options.errorMessage) {
    metadata.errorMessage = options.errorMessage.slice(0, 500);
  }

  if (options.expectedSourceAccount) {
    metadata.expectedSourceAccount = options.expectedSourceAccount;
  }

  if (options.authorizedScope) {
    metadata.authorizedScope = options.authorizedScope;
  }

  if (options.requiredScopes && options.requiredScopes.length > 0) {
    metadata.requiredScopes = [...options.requiredScopes];
  }

  if (options.sagaId) {
    metadata.sagaId = options.sagaId;
  }

  if (typeof options.stepIndex === 'number') {
    metadata.stepIndex = options.stepIndex;
  }

  if (typeof options.totalSteps === 'number') {
    metadata.totalSteps = options.totalSteps;
  }

  if (options.compensatingAction) {
    metadata.compensatingAction = options.compensatingAction;
  }

  if (options.partialState) {
    metadata.partialState = options.partialState;
  }

  if (options.outcome === 'partial') {
    metadata.partialStateOutcome = true;
    metadata.reconcilable = true;
  }

  return metadata;
}
