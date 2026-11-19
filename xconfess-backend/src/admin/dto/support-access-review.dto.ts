import { IsEnum } from 'class-validator';

export enum SupportAccessPurpose {
  ACCOUNT_STATUS = 'account_status',
  ACCOUNT_RECOVERY = 'account_recovery',
}

export enum SupportAccessScope {
  ACCOUNT_STATUS = 'account_status',
  SECURITY_STATUS = 'security_status',
}

export class SupportAccessReviewDto {
  @IsEnum(SupportAccessPurpose)
  purpose!: SupportAccessPurpose;

  @IsEnum(SupportAccessScope)
  scope!: SupportAccessScope;
}
