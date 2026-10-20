// src/moderation/dtos/run-evaluation.dto.ts
import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ModerationCategory } from '../ai-moderation.service';
import {
  SupportedEvaluationLanguage,
  SUPPORTED_EVALUATION_LANGUAGES,
} from '../language-evaluation.types';

export class RunEvaluationDto {
  @ApiPropertyOptional({
    description: 'Subset of supported languages to evaluate',
    example: ['en', 'es', 'fr'],
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(SUPPORTED_EVALUATION_LANGUAGES, { each: true })
  languages?: SupportedEvaluationLanguage[];

  @ApiPropertyOptional({
    description: 'Subset of moderation categories to evaluate',
    example: ['hate_speech', 'harassment'],
    isArray: true,
    enum: ModerationCategory,
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsEnum(ModerationCategory, { each: true })
  categories?: ModerationCategory[];

  @ApiPropertyOptional({
    description: 'Disparity deviation threshold (0 to 1, default 0.15)',
    example: 0.15,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  disparityThreshold?: number;
}
