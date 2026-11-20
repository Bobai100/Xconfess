export type ExportReceiptStatus =
  | 'REQUESTED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'FAILED';

export interface ExportReceipt {
  receiptId: string;
  exportRequestId: string;
  userId: string;
  status: ExportReceiptStatus;
  requestedAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  fileSizeBytes: number | null;
  sha256Digest: string | null;
  dataCategoriesIncluded: string[];
  retentionNote: string;
}

export interface RequestingUserContext {
  userId: string;
  role: 'USER' | 'ADMIN' | 'MODERATOR' | 'ANONYMOUS';
}
