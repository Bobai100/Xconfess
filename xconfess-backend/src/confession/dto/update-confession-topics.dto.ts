import { IsArray, IsNotEmpty, IsString, ArrayMaxSize } from 'class-validator';

export class UpdateConfessionTopicsDto {
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10)
  topics: string[];
}
