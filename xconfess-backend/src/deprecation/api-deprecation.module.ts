import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiDeprecationMetric } from './entities/api-deprecation-metric.entity';
import { ApiDeprecationTelemetryService } from './api-deprecation-telemetry.service';
import { ApiDeprecationInterceptor } from './api-deprecation.interceptor';
import { ApiDeprecationController } from './api-deprecation.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ApiDeprecationMetric])],
  controllers: [ApiDeprecationController],
  providers: [ApiDeprecationTelemetryService, ApiDeprecationInterceptor],
  exports: [ApiDeprecationTelemetryService, ApiDeprecationInterceptor],
})
export class ApiDeprecationModule {}
