import {
  BadRequestException,
  Body,
  Controller,
  Get,
  InternalServerErrorException,
  Logger,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiOkResponse, ApiParam } from '@nestjs/swagger';
import { StellarConfigResponseDto } from './dto/stellar-config-response.dto';
import { ConfigService } from '@nestjs/config';
import * as StellarSDK from '@stellar/stellar-sdk';
import { StellarService } from './stellar.service';
import { ContractService } from './contract.service';
import { VerifyTransactionDto } from './dto/verify-transaction.dto';
import { InvokeContractDto } from './dto/invoke-contract.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/user.entity';
import { StellarInvokeContractGuard } from './guards/stellar-invoke-contract.guard';
import { EventRangeVerifierService } from './event-range-verifier.service';
import { VerifyEventRangeDto } from './dto/verify-event-range.dto';
import { ReprocessEventRangeDto } from './dto/reprocess-event-range.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditActionType } from '../audit-log/audit-log.entity';
import { AuthenticatedRequest } from '../auth/interfaces/jwt-payload.interface';
import { getStellarInvocationPolicy } from './stellar-invocation-policy';
import {
  buildAuditContextFromRequest,
  buildStellarInvocationAuditMetadata,
} from './stellar-invocation-audit';
import { redactSecretStrings } from '../utils/redact-secrets';
import { RequestCost, COST } from '../common/guards/cost-throttler.guard';

@ApiTags('Stellar')
@Controller('stellar')
export class StellarController {
  private readonly logger = new Logger(StellarController.name);

  constructor(
    private stellarService: StellarService,
    private contractService: ContractService,
    private configService: ConfigService,
    private auditLogService: AuditLogService,
    private eventRangeVerifierService: EventRangeVerifierService,
  ) {}

  @Get('anchors')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get paginated anchored confessions for the current user' })
  @ApiResponse({ status: 200, description: 'Paginated list of anchored confessions' })
  async getUserAnchors(
    @Req() req: AuthenticatedRequest,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.stellarService.getUserAnchors(req.user.id, page || 1, limit || 10);
  }

  @Get('config')
  @ApiOperation({
    summary: 'Get Stellar network and contract deployment configuration',
    description:
      'Returns the configured network, public RPC endpoints, and Soroban contract IDs. ' +
      'Never includes secrets, deployer keys, or server signer material. ' +
      'Unset contract IDs are returned as null.',
  })
  @ApiOkResponse({
    description: 'Public Stellar deployment summary',
    type: StellarConfigResponseDto,
  })
  getConfig(): StellarConfigResponseDto {
    return this.stellarService.getNetworkConfig();
  }

  @Get('anchor/verify/:confessionHash')
  @ApiOperation({ summary: 'Verify a confession hash on the anchor contract' })
  @ApiParam({
    name: 'confessionHash',
    description: 'Hex-encoded confession hash to verify on-chain',
  })
  @ApiResponse({
    status: 200,
    description: 'Confession anchor verification result',
    schema: {
      example: {
        isAnchored: true,
        timestamp: 1684939200,
      },
    },
  })
  async verifyAnchor(@Param('confessionHash') confessionHash: string, @Req() req: any) {
    const requestId = req.requestId as string | undefined;
    this.logger.log({
      message: 'Anchor verify started',
      requestId,
      confessionHash,
    });

    if (!/^[0-9a-fA-F]{64}$/.test(confessionHash)) {
      throw new BadRequestException('Invalid confession hash format. Expected 32-byte hex.');
    }

    const timestamp = await this.contractService.verifyConfession(confessionHash);
    this.logger.log({
      message: 'Anchor verify completed',
      requestId,
      confessionHash,
      isAnchored: timestamp !== null,
    });
    return {
      isAnchored: timestamp !== null,
      timestamp,
    };
  }

  @Get('balance/:address')
  @ApiOperation({ summary: 'Get account balance' })
  @ApiResponse({ status: 200, description: 'Account balance' })
  async getBalance(@Param('address') address: string) {
    return this.stellarService.getAccountBalance(address);
  }

  @Post('verify')
  @RequestCost(COST.CHAIN) // on-chain verification — most expensive tier
  @ApiOperation({ summary: 'Verify transaction on-chain' })
  @ApiResponse({ status: 200, description: 'Transaction verification result' })
  async verifyTransaction(@Body() dto: VerifyTransactionDto, @Req() req: any) {
    const requestId = req.requestId as string | undefined;
    this.logger.log({ message: 'Stellar tx verify started', requestId, txHash: dto.txHash });
    return this.stellarService.verifyTransaction(dto.txHash, requestId);
  }

  @Get('account-exists/:address')
  @ApiOperation({ summary: 'Check if account exists' })
  async accountExists(@Param('address') address: string) {
    const exists = await this.stellarService.accountExists(address);
    return { exists };
  }

  @Post('invoke-contract')
  @RequestCost(COST.CHAIN) // Soroban contract invocation — most expensive tier
  @ApiOperation({
    summary: 'Invoke allowlisted Soroban operation (server-signed, admin)',
  })
  @UseGuards(JwtAuthGuard, StellarInvokeContractGuard)
  async invokeContract(
    @Body() dto: InvokeContractDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const signerSecret = this.configService.get<string>(
      'STELLAR_SERVER_SECRET',
    );
    if (!signerSecret) {
      throw new BadRequestException(
        'Stellar server signer secret is not configured',
      );
    }

    let signerPk: string;
    try {
      signerPk = StellarSDK.Keypair.fromSecret(signerSecret).publicKey();
    } catch {
      // Never propagate the underlying SDK error — it takes the raw secret
      // as input and its message content is not guaranteed to omit it.
      throw new InternalServerErrorException(
        'Stellar server signer secret is misconfigured',
      );
    }
    const invocation = this.contractService.invocationFromAllowlistedDto(
      dto,
      signerPk,
    );
    const policy = getStellarInvocationPolicy(dto.operation);

    if (dto.sourceAccount !== signerPk) {
      await this.auditStellarInvocation(req, dto, {
        allowlistClass: policy?.allowlistClass,
        contractId: invocation.contractId,
        functionName: invocation.functionName,
        sourceAccount: dto.sourceAccount,
        outcome: 'denied',
        denialReason: 'source_account_mismatch',
        expectedSourceAccount: signerPk,
      });
      throw new BadRequestException(
        'sourceAccount must be the public key of the configured server signer',
      );
    }

    try {
      const result = await this.contractService.invokeContract(
        invocation,
        signerSecret,
      );
      await this.auditStellarInvocation(req, dto, {
        allowlistClass: policy?.allowlistClass,
        outcome: result.success ? 'success' : 'failed',
        transactionHash: result.hash,
        chainSuccess: result.success,
        contractId: invocation.contractId,
        functionName: invocation.functionName,
        sourceAccount: dto.sourceAccount,
        authorizedScope: (req as any).stellarInvocationScopeMatch,
      });
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await this.auditStellarInvocation(req, dto, {
        allowlistClass: policy?.allowlistClass,
        outcome: 'failed',
        contractId: invocation.contractId,
        functionName: invocation.functionName,
        sourceAccount: dto.sourceAccount,
        // Redacted defensively — this message can originate from the signing
        // path and must never persist secret-shaped material to the audit log.
        errorMessage: redactSecretStrings(message),
        authorizedScope: (req as any).stellarInvocationScopeMatch,
      });
      throw err;
    }
  }

  @Post('events/verify-range')
  @RequestCost(COST.CHAIN) // reads ledger data from the network
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Verify indexed Soroban event ranges against ledger data (admin)',
    description:
      'Read-only comparison of checkpointed indexed event ranges with the ' +
      'events returned by the network. Reports gaps and misclassifications ' +
      'grouped by checkpoint. Never mutates indexed state.',
  })
  @ApiResponse({ status: 200, description: 'Event range verification report' })
  @ApiResponse({ status: 400, description: 'Invalid range or checkpoint parameters' })
  @ApiResponse({ status: 403, description: 'Caller is not an administrator' })
  async verifyEventRange(
    @Body() dto: VerifyEventRangeDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const requestId = req.requestId as string | undefined;
    this.logger.log({
      message: 'Event range verification started',
      requestId,
      fromLedger: dto.fromLedger,
      toLedger: dto.toLedger,
      checkpointId: dto.checkpointId,
    });
    const report = await this.eventRangeVerifierService.verifyRange({
      fromLedger: dto.fromLedger,
      toLedger: dto.toLedger,
      checkpointId: dto.checkpointId,
      contractIds: dto.contractIds,
    });
    this.logger.log({
      message: 'Event range verification completed',
      requestId,
      gaps: report.gaps.length,
      misclassified: report.misclassified.length,
    });
    return report;
  }

  @Post('events/reprocess-range')
  @RequestCost(COST.CHAIN) // re-reads ledger data and rewrites indexed ranges
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Trigger bounded reprocessing of an indexed event range (admin)',
    description:
      'Re-fetches a bounded ledger range and rewrites the indexed events for ' +
      'it. The range is capped by the configured maximum span; requests that ' +
      'exceed the cap are rejected. Only gaps or misclassifications reported ' +
      'by the verifier should be reprocessed.',
  })
  @ApiResponse({ status: 200, description: 'Bounded reprocessing result' })
  @ApiResponse({ status: 400, description: 'Invalid or oversized range' })
  @ApiResponse({ status: 403, description: 'Caller is not an administrator' })
  async reprocessEventRange(
    @Body() dto: ReprocessEventRangeDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const requestId = req.requestId as string | undefined;
    this.logger.log({
      message: 'Event range reprocessing started',
      requestId,
      fromLedger: dto.fromLedger,
      toLedger: dto.toLedger,
      checkpointId: dto.checkpointId,
    });
    const result = await this.eventRangeVerifierService.reprocessRange({
      fromLedger: dto.fromLedger,
      toLedger: dto.toLedger,
      checkpointId: dto.checkpointId,
      contractIds: dto.contractIds,
    });
    this.logger.log({
      message: 'Event range reprocessing completed',
      requestId,
      reprocessed: result.reprocessed,
    });
    return result;
  }

  private async auditStellarInvocation(
    req: AuthenticatedRequest,
    dto: InvokeContractDto,
    fields: Omit<
      Parameters<typeof buildStellarInvocationAuditMetadata>[0],
      'operation'
    >,
  ): Promise<void> {
    await this.auditLogService.log({
      actionType: AuditActionType.STELLAR_CONTRACT_INVOCATION,
      context: buildAuditContextFromRequest(req as typeof req & {
        requestId?: string;
      }),
      metadata: {
        ...buildStellarInvocationAuditMetadata({
          operation: dto.operation,
          ...fields,
        }),
        actorUserId: req.user.id,
      },
    });
  }
}
