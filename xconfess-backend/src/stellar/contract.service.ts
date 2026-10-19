import { Injectable, Logger } from '@nestjs/common';
import * as StellarSDK from '@stellar/stellar-sdk';
import { StellarConfigService } from './stellar-config.service';
import { TransactionBuilderService } from './transaction-builder.service';
import {
  IContractInvocation,
  ITransactionResult,
} from './interfaces/stellar-config.interface';
import { handleStellarError } from './utils/stellar-error.handler';
import { encodeContractArgs, ContractArg } from './utils/parameter.encoder';
import { redactSecretStrings } from '../utils/redact-secrets';
import { InvokeContractDto } from './dto/invoke-contract.dto';
import { getStellarInvocationPolicy } from './stellar-invocation-policy';
import {
  TransactionLatencyBudgetService,
  TransactionPhase,
} from './transaction-latency-budget.service';

/**
 * A single step in a multi-contract workflow.
 *
 * Each step is an external call. `compensate` (optional) is the compensating
 * action that must be invoked if a *later* step fails. If no compensating
 * action is registered the audit record is marked for reconciliation instead.
 */
export interface IMultiContractStep {
  /** Stable, human-readable name used in audit records and logs. */
  name: string;
  /** The low-level invocation to perform. */
  invocation: IContractInvocation;
  /** Signer secret used to sign this step's transaction. */
  signerSecret: string;
  /**
   * Compensating action for this step. Invoked (in reverse order) when a later
   * step fails. Must be idempotent — recovery may retry it.
   */
  compensate?: (context: IMultiContractContext) => Promise<void>;
}

export interface IMultiContractContext {
  /** Identifier of the workflow run, shared by all audit records. */
  workflowId: string;
  /** The step that triggered recovery (the failing step). */
  failedStep: string;
  /** The step being compensated. */
  step: string;
  /** Result of the step being compensated, if it succeeded. */
  result?: ITransactionResult;
}

export type MultiContractStepStatus =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'compensated'
  | 'compensation_failed'
  | 'needs_reconciliation';

export interface IMultiContractAuditRecord {
  workflowId: string;
  step: string;
  status: MultiContractStepStatus;
  /** Transaction hash, when the external call produced one. */
  hash?: string;
  /** Redacted error message for failed steps / compensations. */
  error?: string;
  /** Number of compensation attempts made for this step. */
  compensationAttempts: number;
  updatedAt: string;
}

export interface IMultiContractResult {
  workflowId: string;
  success: boolean;
  /** Per-step audit records, in execution order. */
  records: IMultiContractAuditRecord[];
  /** Records that require manual reconciliation (no compensation available). */
  needsReconciliation: IMultiContractAuditRecord[];
  /** The error that aborted the workflow, if any (redacted). */
  error?: string;
}

/**
 * Bounded recovery configuration for multi-contract workflows.
 * Read from the Stellar config so operators can tune rollout behaviour.
 */
export interface IMultiContractRecoveryOptions {
  /** Maximum compensation attempts per step. Defaults to 3. */
  maxCompensationAttempts?: number;
  /** Base delay (ms) between compensation retries. Defaults to 100. */
  compensationRetryBaseDelayMs?: number;
  /** Maximum delay (ms) between compensation retries. Defaults to 2000. */
  compensationRetryMaxDelayMs?: number;
}

const DEFAULT_RECOVERY_OPTIONS: Required<IMultiContractRecoveryOptions> = {
  maxCompensationAttempts: 3,
  compensationRetryBaseDelayMs: 100,
  compensationRetryMaxDelayMs: 2000,
};

@Injectable()
export class ContractService {
  private readonly logger = new Logger(ContractService.name);

  /**
   * In-memory audit trail of multi-contract workflow runs. Bounded to avoid
   * unbounded growth; oldest entries are evicted first.
   */
  private readonly auditTrail = new Map<string, IMultiContractAuditRecord[]>();
  private static readonly MAX_AUDIT_WORKFLOWS = 1000;

  constructor(
    private stellarConfig: StellarConfigService,
    private txBuilder: TransactionBuilderService,
    private latencyBudget: TransactionLatencyBudgetService,
  ) {}

  /**
   * Map an allowlisted HTTP DTO to a low-level invocation. Contract id and
   * function name are never taken from the client — only from this mapping.
   */
  invocationFromAllowlistedDto(
    dto: InvokeContractDto,
    verifiedSignerPublicKey: string,
  ): IContractInvocation {
    const policy = getStellarInvocationPolicy(dto.operation);

    if (!policy) {
      throw new Error(`Unhandled allowlisted operation: ${dto.operation}`);
    }

    switch (policy.operation) {
      case 'anchor_confession':
        return {
          contractId: this.stellarConfig.getContractId(policy.contractName),
          functionName: policy.functionName,
          args: [
            { type: 'bytes', value: Buffer.from(dto.confessionHash!, 'hex') },
            { type: 'u64', value: dto.timestamp! },
          ],
          sourceAccount: verifiedSignerPublicKey,
        };
      default: {
        const _never: never = policy.operation;
        throw new Error(`Unhandled allowlisted operation: ${String(_never)}`);
      }
    }
  }

  /**
   * Invoke a Soroban contract function.
   * All argument encoding is delegated to parameter.encoder.ts — there is no
   * duplicate encoding logic in this class.
   */
  async invokeContract(
    invocation: IContractInvocation,
    signerSecret: string,
  ): Promise<ITransactionResult> {
    const operationClass = this.latencyBudget.classifyOperation(
      invocation.functionName,
    );
    const network = this.latencyBudget.currentNetwork();
    const startedAt = Date.now();

    try {
      const contract = new StellarSDK.Contract(invocation.contractId);

      // Single encoding path — delegates to parameter.encoder.ts
      const encodedArgs = encodeContractArgs(invocation.args);

      const operation = contract.call(invocation.functionName, ...encodedArgs);

      const tx = await this.txBuilder.buildTransaction(
        invocation.sourceAccount,
        [operation],
      );

      // Simulate first and bind the result to the network and operation inputs.
      // Submission re-validates freshness and rejects if ledger state has aged
      // or changed since simulation (see TransactionBuilderService).
      const simulation = await this.txBuilder.simulateTransaction(tx);
      const signedTx = this.txBuilder.signTransaction(tx, signerSecret);
      const timeoutMs = this.stellarConfig.getConfig().rpcTimeoutMs;
      let timeoutId: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Contract invocation timeout after ${timeoutMs}ms`)),
          timeoutMs,
        );
      });
      let result: ITransactionResult;
      try {
        result = await Promise.race([
          this.txBuilder.submitTransaction(signedTx, simulation),
          timeout,
        ]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }

      // Submission + inclusion + confirmation are completed by the builder's
      // submit path; record the end-to-end latency against the budget.
      this.latencyBudget.recordLatency({
        network,
        operationClass,
        phase: TransactionPhase.CONFIRMATION,
        durationMs: Date.now() - startedAt,
        success: result.success,
      });

      const decodedResult = this.decodeContractResult(result);

      return {
        hash: result.hash,
        success: result.success,
        result: decodedResult,
      };
    } catch (error: unknown) {
      this.latencyBudget.recordLatency({
        network,
        operationClass,
        phase: TransactionPhase.SUBMISSION,
        durationMs: Date.now() - startedAt,
        success: false,
      });
      // Redacted defensively: this can be the signing path's error, which is
      // derived from the server secret key and must never log it verbatim.
      const message = redactSecretStrings(
        error instanceof Error ? error.message : String(error),
      );
      this.logger.error('Contract invocation failed: ' + String(message));
      throw handleStellarError(error);
    }
  }

  /**
   * Anchor a confession hash on-chain.
   * Args are expressed as typed ContractArg objects and encoded by the shared encoder.
   */
  async anchorConfession(
    confessionHash: string,
    timestamp: number,
    signerSecret: string,
  ): Promise<ITransactionResult> {
    const contractId = this.stellarConfig.getContractId('confessionAnchor');
    const signerKeypair = StellarSDK.Keypair.fromSecret(signerSecret);

    return this.invokeContract(
      {
        contractId,
        functionName: 'anchor_confession',
        args: [
          { type: 'bytes', value: Buffer.from(confessionHash, 'hex') },
          { type: 'u64', value: timestamp },
        ] satisfies ContractArg[],
        sourceAccount: signerKeypair.publicKey(),
      },
      signerSecret,
    );
  }

  /**
   * Verify a confession hash on-chain (read-only — no transaction).
   * Uses bounded retries with exponential backoff for transient failures.
   */
  async verifyConfession(confessionHash: string): Promise<number | null> {
    const rpcConfig = this.stellarConfig.getConfig();
    const maxRetries = rpcConfig.rpcMaxRetries;
    const baseDelay = rpcConfig.rpcRetryBaseDelayMs;
    const maxDelay = rpcConfig.rpcRetryMaxDelayMs;
    const network = this.latencyBudget.currentNetwork();
    const operationClass = this.latencyBudget.classifyOperation(
      'verify_confession',
    );

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const startedAt = Date.now();
      try {
        const contractId = this.stellarConfig.getContractId('confessionAnchor');
        const contract = new StellarSDK.Contract(contractId);

        const result = await contract.call(
          'verify_confession',
          StellarSDK.nativeToScVal(confessionHash, { type: 'bytes' }),
        );

        this.latencyBudget.recordLatency({
          network,
          operationClass,
          phase: TransactionPhase.CONFIRMATION,
          durationMs: Date.now() - startedAt,
          success: true,
        });

        const timestamp = StellarSDK.scValToNative(result as any);
        return timestamp || null;
      } catch (error: unknown) {
        this.latencyBudget.recordLatency({
          network,
          operationClass,
          phase: TransactionPhase.SUBMISSION,
          durationMs: Date.now() - startedAt,
          success: false,
        });
        const message = error instanceof Error ? error.message : String(error);
        const isRetryable =
          message.toLowerCase().includes('timeout') ||
          message.toLowerCase().includes('econnrefused') ||
          message.toLowerCase().includes('econnreset') ||
          message.toLowerCase().includes('network');

        if (!isRetryable || attempt >= maxRetries) {
          this.logger.warn(
            'Confession not found on-chain: ' + String(confessionHash),
          );
          return null;
        }

        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        this.logger.warn(
          `verifyConfession RPC failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${message}`,
        );
        await new Promise((res) => setTimeout(res, delay));
      }
    }

    return null;
  }

  /**
   * Execute a multi-contract workflow with bounded recovery.
   *
   * Semantics:
   * - Steps run sequentially. Every external call is recorded in the audit
   *   trail *before* it is attempted (status `pending`) and updated after.
   * - On failure, previously succeeded steps are compensated in reverse order.
   *   A step without a registered `compensate` action is marked
   *   `needs_reconciliation` so operators can reconcile backend state.
   * - Compensation is bounded: at most `maxCompensationAttempts` attempts per
   *   step with exponential backoff. Exhausted compensations are marked
   *   `compensation_failed` and surfaced in `needsReconciliation`.
   * - The workflow never throws for step failures; callers inspect the result.
   *   Authorization errors (e.g. missing signer) still propagate as thrown
   *   errors because no external call has been made yet.
   */
  async invokeMultiContract(
    steps: IMultiContractStep[],
    options: IMultiContractRecoveryOptions = {},
  ): Promise<IMultiContractResult> {
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error('invokeMultiContract requires at least one step');
    }
    for (const step of steps) {
      if (!step.name || !step.invocation || !step.signerSecret) {
        throw new Error(
          'invokeMultiContract step requires name, invocation and signerSecret',
        );
      }
    }

    const workflowId = this.generateWorkflowId();
    const records: IMultiContractAuditRecord[] = steps.map((step) => ({
      workflowId,
      step: step.name,
      status: 'pending' as MultiContractStepStatus,
      compensationAttempts: 0,
      updatedAt: new Date().toISOString(),
    }));
    this.storeAudit(workflowId, records);

    const succeeded: Array<{ index: number; result: ITransactionResult }> = [];
    let failure: { index: number; error: unknown } | undefined;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      try {
        const result = await this.invokeContract(
          step.invocation,
          step.signerSecret,
        );
        records[i].status = 'succeeded';
        records[i].hash = result.hash;
        records[i].updatedAt = new Date().toISOString();
        succeeded.push({ index: i, result });
      } catch (error: unknown) {
        records[i].status = 'failed';
        records[i].error = redactSecretStrings(
          error instanceof Error ? error.message : String(error),
        );
        records[i].updatedAt = new Date().toISOString();
        failure = { index: i, error };
        break;
      }
    }

    if (!failure) {
      return {
        workflowId,
        success: true,
        records,
        needsReconciliation: [],
      };
    }

    const failedStep = steps[failure.index].name;
    const recovery = { ...DEFAULT_RECOVERY_OPTIONS, ...options };
    const needsReconciliation: IMultiContractAuditRecord[] = [];

    // Compensate in reverse order of success.
    for (let s = succeeded.length - 1; s >= 0; s--) {
      const { index, result } = succeeded[s];
      const step = steps[index];
      const record = records[index];

      if (!step.compensate) {
        record.status = 'needs_reconciliation';
        record.updatedAt = new Date().toISOString();
        needsReconciliation.push(record);
        this.logger.warn(
          `Workflow ${workflowId}: step "${step.name}" has no compensation; marked for reconciliation`,
        );
        continue;
      }

      const context: IMultiContractContext = {
        workflowId,
        failedStep,
        step: step.name,
        result,
      };

      const compensated = await this.runCompensation(
        step,
        record,
        context,
        recovery,
      );
      if (!compensated) {
        needsReconciliation.push(record);
      }
    }

    return {
      workflowId,
      success: false,
      records,
      needsReconciliation,
      error: redactSecretStrings(
        failure.error instanceof Error
          ? failure.error.message
          : String(failure.error),
      ),
    };
  }

  /**
   * Retrieve the audit trail for a workflow run (for reconciliation tooling).
   */
  getMultiContractAudit(workflowId: string): IMultiContractAuditRecord[] {
    const records = this.auditTrail.get(workflowId);
    return records ? records.map((r) => ({ ...r })) : [];
  }

  /**
   * Run a single step's compensation with bounded retries and backoff.
   * Returns true when compensation succeeded, false when it was exhausted.
   */
  private async runCompensation(
    step: IMultiContractStep,
    record: IMultiContractAuditRecord,
    context: IMultiContractContext,
    recovery: Required<IMultiContractRecoveryOptions>,
  ): Promise<boolean> {
    const maxAttempts = Math.max(1, recovery.maxCompensationAttempts);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      record.compensationAttempts = attempt;
      try {
        await step.compensate!(context);
        record.status = 'compensated';
        record.updatedAt = new Date().toISOString();
        return true;
      } catch (error: unknown) {
        const message = redactSecretStrings(
          error instanceof Error ? error.message : String(error),
        );
        record.error = message;
        record.updatedAt = new Date().toISOString();
        this.logger.warn(
          `Workflow ${context.workflowId}: compensation for "${step.name}" failed (attempt ${attempt}/${maxAttempts}): ${message}`,
        );
        if (attempt < maxAttempts) {
          const delay = Math.min(
            recovery.compensationRetryBaseDelayMs * Math.pow(2, attempt - 1),
            recovery.compensationRetryMaxDelayMs,
          );
          await new Promise((res) => setTimeout(res, delay));
        }
      }
    }

    record.status = 'compensation_failed';
    record.updatedAt = new Date().toISOString();
    this.logger.error(
      `Workflow ${context.workflowId}: compensation for "${step.name}" exhausted after ${maxAttempts} attempts; marked for reconciliation`,
    );
    return false;
  }

  private storeAudit(
    workflowId: string,
    records: IMultiContractAuditRecord[],
  ): void {
    this.auditTrail.set(workflowId, records);
    if (this.auditTrail.size > ContractService.MAX_AUDIT_WORKFLOWS) {
      const oldest = this.auditTrail.keys().next().value;
      if (oldest !== undefined) {
        this.auditTrail.delete(oldest);
      }
    }
  }

  private generateWorkflowId(): string {
    return `wf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * Decode a contract result XDR into a native JS value.
   */
  private decodeContractResult(result: any): any {
    try {
      if (!result.result_xdr) return null;
      const xdr = StellarSDK.xdr.TransactionResult.fromXDR(
        result.result_xdr,
        'base64',
      );
      const resultValue = xdr.result().value();
      return StellarSDK.scValToNative(resultValue as any);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Could not decode contract result: ' + String(message));
      return null;
    }
  }
}
