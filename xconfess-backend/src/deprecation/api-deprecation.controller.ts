import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiDeprecationTelemetryService } from './api-deprecation-telemetry.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';

@Controller('admin/telemetry/deprecated-endpoints')
@UseGuards(JwtAuthGuard, AdminGuard)
export class ApiDeprecationController {
  constructor(
    private readonly telemetryService: ApiDeprecationTelemetryService,
  ) {}

  @Get()
  async getDeprecatedEndpointMetrics() {
    return this.telemetryService.getMetrics();
  }
}
