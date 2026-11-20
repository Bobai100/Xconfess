import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  ArrayNotEmpty,
} from 'class-validator';

export class CreateWebhookSubscriptionDto {
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @IsNotEmpty()
  targetUrl: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  events: string[];

  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateWebhookSubscriptionDto {
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  targetUrl?: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  events?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  description?: string;
}
