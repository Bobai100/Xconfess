import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsString,
  MaxLength,
} from 'class-validator';

export enum CalibrationDecision {
  APPROVE = 'approve',
  FLAG = 'flag',
  REMOVE = 'remove',
  ESCALATE = 'escalate',
}

export class CreateCalibrationSessionDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  caseIds!: string[];
}

export class SubmitCalibrationAssessmentDto {
  @IsString()
  @MaxLength(100)
  caseId!: string;

  @IsEnum(CalibrationDecision)
  decision!: CalibrationDecision;
}
