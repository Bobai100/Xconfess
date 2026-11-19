import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsObject,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateModerationAccessGrantDto {
  @IsInt()
  @Min(1)
  userId: number;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason: string;

  @IsDateString()
  expiresAt: string;
}

export class ShadowEvaluationDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  fixtures: Array<{ type: string; currentDecision: string }>;

  @IsObject()
  rules: Record<string, { action: string; explanation: string }>;
}

export class PreviewPolicyDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  reportIds: string[];

  @IsObject()
  rules: Record<string, { action: string; explanation: string }>;
}
