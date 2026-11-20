import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import {
  API_DEPRECATED_KEY,
  DeprecationOptions,
} from './api-deprecated.decorator';
import { ApiDeprecationTelemetryService } from './api-deprecation-telemetry.service';

@Injectable()
export class ApiDeprecationInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly telemetryService: ApiDeprecationTelemetryService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const deprecationOptions = this.reflector.getAllAndOverride<DeprecationOptions>(
      API_DEPRECATED_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (deprecationOptions) {
      const http = context.switchToHttp();
      const response = http.getResponse();
      const request = http.getRequest();

      // RFC 8594 Deprecation Header
      response.setHeader('Deprecation', 'true');

      // RFC 8594 Sunset Header (if sunset date provided)
      if (deprecationOptions.sunsetDate) {
        const sunsetDateObj = new Date(deprecationOptions.sunsetDate);
        if (!isNaN(sunsetDateObj.getTime())) {
          response.setHeader('Sunset', sunsetDateObj.toUTCString());
        }
      }

      // RFC 8288 Link Headers
      const links: string[] = [];
      if (deprecationOptions.alternativeRoute) {
        links.push(`<${deprecationOptions.alternativeRoute}>; rel="successor-version"`);
      }
      if (deprecationOptions.documentationUrl) {
        links.push(`<${deprecationOptions.documentationUrl}>; rel="deprecation"`);
      }
      if (links.length > 0) {
        response.setHeader('Link', links.join(', '));
      }

      // Record deprecation usage telemetry asynchronously
      const endpointPath = request.baseUrl ? `${request.baseUrl}${request.path}` : request.path || request.url;
      const method = request.method || 'GET';
      const userAgent = request.headers ? request.headers['user-agent'] : undefined;

      this.telemetryService.recordUsage({
        endpointPath,
        method,
        userAgent,
      });
    }

    return next.handle();
  }
}
