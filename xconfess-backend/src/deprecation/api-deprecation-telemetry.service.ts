import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { ApiDeprecationMetric } from './entities/api-deprecation-metric.entity';

export interface RecordUsageParams {
  endpointPath: string;
  method: string;
  userAgent?: string;
}

@Injectable()
export class ApiDeprecationTelemetryService {
  private readonly logger = new Logger(ApiDeprecationTelemetryService.name);

  constructor(
    @InjectRepository(ApiDeprecationMetric)
    private readonly metricRepo: Repository<ApiDeprecationMetric>,
  ) {}

  /**
   * Sanitizes User-Agent to extract client family only (e.g. Chrome, Firefox, curl, Postman),
   * ensuring no unique user-identifying build numbers, tracking tokens or session fingerprints are stored.
   */
  private extractClientFamily(userAgent?: string): string {
    if (!userAgent) return 'unknown';
    const ua = userAgent.toLowerCase();
    if (ua.includes('curl')) return 'curl';
    if (ua.includes('postman')) return 'postman';
    if (ua.includes('chrome')) return 'chrome';
    if (ua.includes('firefox')) return 'firefox';
    if (ua.includes('safari') && !ua.includes('chrome')) return 'safari';
    if (ua.includes('edge')) return 'edge';
    if (ua.includes('python')) return 'python-requests';
    return 'generic-http-client';
  }

  /**
   * Record deprecation telemetry strictly without request bodies or user-identifying query values.
   */
  async recordUsage({ endpointPath, method, userAgent }: RecordUsageParams): Promise<void> {
    try {
      const normalizedPath = endpointPath.split('?')[0]; // Strip all query params
      const clientFamily = this.extractClientFamily(userAgent);
      const now = new Date();

      let metric = await this.metricRepo.findOne({
        where: { endpointPath: normalizedPath, method: method.toUpperCase() },
      });

      if (!metric) {
        metric = this.metricRepo.create({
          endpointPath: normalizedPath,
          method: method.toUpperCase(),
          callCount: 1,
          firstSeenAt: now,
          lastSeenAt: now,
          sampleClientFamily: clientFamily,
        });
      } else {
        metric.callCount = Number(metric.callCount) + 1;
        metric.lastSeenAt = now;
        metric.sampleClientFamily = clientFamily;
      }

      await this.metricRepo.save(metric);
    } catch (err: any) {
      // Observability must not crash the request lifecycle
      this.logger.warn(`Failed to record deprecation telemetry: ${err.message}`);
    }
  }

  async getMetrics(): Promise<ApiDeprecationMetric[]> {
    return this.metricRepo.find({
      order: { lastSeenAt: 'DESC' },
    });
  }
}
