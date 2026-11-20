import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { ApiDeprecationInterceptor } from './api-deprecation.interceptor';
import { ApiDeprecationTelemetryService } from './api-deprecation-telemetry.service';
import { ExecutionContext, CallHandler } from '@nestjs/common';

describe('ApiDeprecationInterceptor', () => {
  let interceptor: ApiDeprecationInterceptor;
  let reflector: Reflector;
  let telemetryService: ApiDeprecationTelemetryService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiDeprecationInterceptor,
        {
          provide: Reflector,
          useValue: {
            getAllAndOverride: jest.fn(),
          },
        },
        {
          provide: ApiDeprecationTelemetryService,
          useValue: {
            recordUsage: jest.fn().mockResolvedValue(undefined),
            getMetrics: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    interceptor = module.get<ApiDeprecationInterceptor>(ApiDeprecationInterceptor);
    reflector = module.get<Reflector>(Reflector);
    telemetryService = module.get<ApiDeprecationTelemetryService>(ApiDeprecationTelemetryService);
  });

  it('should inject RFC 8594 headers when endpoint is deprecated', (done) => {
    const setHeaderMock = jest.fn();
    const mockContext = {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: jest.fn().mockReturnValue({
        getResponse: jest.fn().mockReturnValue({ setHeader: setHeaderMock }),
        getRequest: jest.fn().mockReturnValue({
          path: '/api/v1/legacy-confessions',
          method: 'GET',
          headers: { 'user-agent': 'Mozilla/5.0' },
        }),
      }),
    } as unknown as ExecutionContext;

    const mockCallHandler: CallHandler = {
      handle: () => of({ success: true }),
    };

    (reflector.getAllAndOverride as jest.Mock).mockReturnValue({
      sunsetDate: '2026-12-31T23:59:59Z',
      alternativeRoute: '/api/v2/confessions',
      documentationUrl: 'https://docs.xconfess.app/migration',
    });

    interceptor.intercept(mockContext, mockCallHandler).subscribe(() => {
      expect(setHeaderMock).toHaveBeenCalledWith('Deprecation', 'true');
      expect(setHeaderMock).toHaveBeenCalledWith('Sunset', expect.stringContaining('2026'));
      expect(setHeaderMock).toHaveBeenCalledWith('Link', expect.stringContaining('/api/v2/confessions'));
      expect(telemetryService.recordUsage).toHaveBeenCalledWith({
        endpointPath: '/api/v1/legacy-confessions',
        method: 'GET',
        userAgent: 'Mozilla/5.0',
      });
      done();
    });
  });

  it('should not set headers on non-deprecated routes', (done) => {
    const setHeaderMock = jest.fn();
    const mockContext = {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: jest.fn().mockReturnValue({
        getResponse: jest.fn().mockReturnValue({ setHeader: setHeaderMock }),
        getRequest: jest.fn().mockReturnValue({ path: '/api/v1/confessions', method: 'GET' }),
      }),
    } as unknown as ExecutionContext;

    const mockCallHandler: CallHandler = {
      handle: () => of({ success: true }),
    };

    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(null);

    interceptor.intercept(mockContext, mockCallHandler).subscribe(() => {
      expect(setHeaderMock).not.toHaveBeenCalled();
      expect(telemetryService.recordUsage).not.toHaveBeenCalled();
      done();
    });
  });
});
