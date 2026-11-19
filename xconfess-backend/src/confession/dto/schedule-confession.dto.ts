import { IsDateString, IsOptional, IsTimeZone } from 'class-validator';

export class ScheduleConfessionDto {
  @IsDateString()
  publishAt: string;

  @IsOptional()
  @IsTimeZone()
  timezone?: string;
}
