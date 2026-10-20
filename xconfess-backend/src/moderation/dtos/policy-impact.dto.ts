import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNumber,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class PolicyImpactThresholdsDto {
  @ApiProperty({ example: 0.8, minimum: 0, maximum: 1 })
  @IsNumber()
  @Min(0)
  @Max(1)
  highThreshold: number;

  @ApiProperty({ example: 0.5, minimum: 0, maximum: 1 })
  @IsNumber()
  @Min(0)
  @Max(1)
  mediumThreshold: number;
}

export class ApprovePolicyImpactDto extends PolicyImpactThresholdsDto {
  @ApiProperty({ description: 'Must be true to apply the previewed policy.' })
  @IsBoolean()
  approved: boolean;

  @ApiProperty({ description: 'One-time ID returned by policy-impact-preview.' })
  @IsString()
  @IsUUID()
  previewId: string;
}
