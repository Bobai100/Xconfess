import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  ExportReceipt,
  ExportReceiptStatus,
  RequestingUserContext,
} from './export-receipt.types';

@Injectable()
export class ExportReceiptService {
  private readonly receipts = new Map<string, ExportReceipt>();

  /**
   * Initializes a receipt upon export request
   */
  async createReceipt(
    userId: string,
    exportRequestId: string,
    categories: string[] = ['PROFILE', 'CONFESSIONS', 'PREFERENCES'],
  ): Promise<ExportReceipt> {
    if (!userId || !exportRequestId) {
      throw new BadRequestException('userId and exportRequestId are required');
    }

    const receiptId = randomUUID();
    const receipt: ExportReceipt = {
      receiptId,
      exportRequestId,
      userId,
      status: 'REQUESTED',
      requestedAt: new Date().toISOString(),
      completedAt: null,
      expiresAt: null,
      fileSizeBytes: null,
      sha256Digest: null,
      dataCategoriesIncluded: categories,
      retentionNote:
        'Export payloads are stored ephemerally and purged upon expiry. Only cryptographic receipt metadata is retained for user auditability.',
    };

    this.receipts.set(receiptId, receipt);
    return receipt;
  }

  /**
   * Records completion metadata without saving any raw export data
   */
  async recordCompletion(
    receiptId: string,
    metadata: {
      fileSizeBytes: number;
      sha256Digest: string;
      expiresAt: string;
    },
  ): Promise<ExportReceipt> {
    const receipt = this.receipts.get(receiptId);
    if (!receipt) {
      throw new NotFoundException(`Export receipt not found: ${receiptId}`);
    }

    receipt.status = 'COMPLETED';
    receipt.completedAt = new Date().toISOString();
    receipt.fileSizeBytes = metadata.fileSizeBytes;
    receipt.sha256Digest = metadata.sha256Digest;
    receipt.expiresAt = metadata.expiresAt;

    return receipt;
  }

  /**
   * Records failure state
   */
  async recordFailure(receiptId: string): Promise<ExportReceipt> {
    const receipt = this.receipts.get(receiptId);
    if (!receipt) {
      throw new NotFoundException(`Export receipt not found: ${receiptId}`);
    }
    receipt.status = 'FAILED';
    receipt.completedAt = new Date().toISOString();
    return receipt;
  }

  /**
   * Retrieves an access receipt with strict privacy boundaries:
   * - Only the requesting user can view their receipt.
   * - Administrators and moderators are explicitly barred by default.
   */
  async getReceiptForUser(
    receiptId: string,
    userContext: RequestingUserContext,
  ): Promise<ExportReceipt> {
    const receipt = this.receipts.get(receiptId);
    if (!receipt) {
      throw new NotFoundException(`Export receipt not found: ${receiptId}`);
    }

    // Default privacy protection: Admins cannot inspect arbitrary user export receipts
    if (userContext.role === 'ADMIN' && userContext.userId !== receipt.userId) {
      throw new ForbiddenException(
        'Platform administrators are barred from viewing user export access receipts by default.',
      );
    }

    if (receipt.userId !== userContext.userId) {
      throw new ForbiddenException('Access denied: You can only view your own data export receipts.');
    }

    return receipt;
  }

  /**
   * Lists receipts for the requesting user
   */
  async listReceiptsForUser(userContext: RequestingUserContext): Promise<ExportReceipt[]> {
    if (!userContext || !userContext.userId) {
      throw new BadRequestException('User context required');
    }

    return Array.from(this.receipts.values()).filter(
      (r) => r.userId === userContext.userId,
    );
  }
}
