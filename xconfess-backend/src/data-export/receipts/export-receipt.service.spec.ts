import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ExportReceiptService } from './export-receipt.service';

describe('ExportReceiptService (#408)', () => {
  let service: ExportReceiptService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ExportReceiptService],
    }).compile();

    service = module.get<ExportReceiptService>(ExportReceiptService);
  });

  it('should create an export receipt without retaining raw payload contents', async () => {
    const receipt = await service.createReceipt('user-123', 'export-req-456', ['PROFILE', 'CONFESSIONS']);

    expect(receipt).toBeDefined();
    expect(receipt.status).toEqual('REQUESTED');
    expect(receipt.userId).toEqual('user-123');
    expect(receipt.exportRequestId).toEqual('export-req-456');
    expect((receipt as any).fileData).toBeUndefined();
    expect((receipt as any).payload).toBeUndefined();
  });

  it('should record completion metadata correctly', async () => {
    const created = await service.createReceipt('user-123', 'export-req-456');
    const completed = await service.recordCompletion(created.receiptId, {
      fileSizeBytes: 1048576,
      sha256Digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      expiresAt: '2026-11-27T10:00:00.000Z',
    });

    expect(completed.status).toEqual('COMPLETED');
    expect(completed.fileSizeBytes).toEqual(1048576);
    expect(completed.sha256Digest).toBeDefined();
  });

  it('should allow requesting user to view their receipt', async () => {
    const receipt = await service.createReceipt('user-alice', 'req-alice');
    const fetched = await service.getReceiptForUser(receipt.receiptId, {
      userId: 'user-alice',
      role: 'USER',
    });

    expect(fetched.receiptId).toEqual(receipt.receiptId);
  });

  it('should deny other users from viewing the receipt', async () => {
    const receipt = await service.createReceipt('user-alice', 'req-alice');
    await expect(
      service.getReceiptForUser(receipt.receiptId, {
        userId: 'user-bob',
        role: 'USER',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('should bar administrators from viewing user receipts by default', async () => {
    const receipt = await service.createReceipt('user-alice', 'req-alice');
    await expect(
      service.getReceiptForUser(receipt.receiptId, {
        userId: 'admin-superuser',
        role: 'ADMIN',
      }),
    ).rejects.toThrow(ForbiddenException);
  });
});
