import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WebhookService } from './webhook.service';
import { WebhookSubscription } from './entities/webhook-subscription.entity';
import {
  WebhookDelivery,
  WebhookDeliveryStatus,
} from './entities/webhook-delivery.entity';
import { NotFoundException, ForbiddenException } from '@nestjs/common';

describe('WebhookService', () => {
  let service: WebhookService;
  let subRepo: any;
  let deliveryRepo: any;

  const mockSub: WebhookSubscription = {
    id: 'sub-uuid-1',
    userId: 1,
    targetUrl: 'https://example.com/webhook',
    secret: 'whsec_abcdef1234567890abcdef1234567890',
    events: ['confession.published'],
    isActive: true,
    description: 'Test webhook',
    createdAt: new Date(),
    updatedAt: new Date(),
    deliveries: [],
  };

  beforeEach(async () => {
    subRepo = {
      create: jest.fn().mockImplementation((dto) => ({ ...dto, id: 'sub-uuid-1' })),
      save: jest.fn().mockImplementation((sub) => Promise.resolve(sub)),
      find: jest.fn().mockResolvedValue([mockSub]),
      findOne: jest.fn().mockResolvedValue(mockSub),
      remove: jest.fn().mockResolvedValue(mockSub),
      createQueryBuilder: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([mockSub]),
      }),
    };

    deliveryRepo = {
      create: jest.fn().mockImplementation((dto) => ({ ...dto, id: 'del-uuid-1' })),
      save: jest.fn().mockImplementation((del) => Promise.resolve(del)),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookService,
        {
          provide: getRepositoryToken(WebhookSubscription),
          useValue: subRepo,
        },
        {
          provide: getRepositoryToken(WebhookDelivery),
          useValue: deliveryRepo,
        },
      ],
    }).compile();

    service = module.get<WebhookService>(WebhookService);
  });

  it('should create an opt-in webhook subscription with generated secret', async () => {
    const result = await service.createSubscription(1, {
      targetUrl: 'https://example.com/hook',
      events: ['confession.published'],
      description: 'Webhook testing',
    });

    expect(result.rawSecret).toBeDefined();
    expect(result.rawSecret.startsWith('whsec_')).toBe(true);
    expect(result.subscription.targetUrl).toBe('https://example.com/hook');
    expect(subRepo.save).toHaveBeenCalled();
  });

  it('should mask webhook secrets when listing subscriptions', async () => {
    const subs = await service.getSubscriptions(1);
    expect(subs[0].secret).toContain('...');
    expect(subs[0].secret).not.toBe(mockSub.secret);
  });

  it('should rotate webhook secrets', async () => {
    const rotated = await service.rotateSecret(1, 'sub-uuid-1');
    expect(rotated.newSecret).toBeDefined();
    expect(rotated.newSecret.startsWith('whsec_')).toBe(true);
    expect(rotated.rotatedAt).toBeInstanceOf(Date);
  });

  it('should compute valid HMAC SHA256 signatures with timestamp', () => {
    const payload = JSON.stringify({ event: 'test' });
    const timestamp = 1700000000;
    const sig = service.computeSignature(payload, 'whsec_secret123', timestamp);
    expect(sig).toHaveLength(64);
  });

  it('should enforce ownership on subscription access', async () => {
    subRepo.findOne.mockResolvedValueOnce({ ...mockSub, userId: 999 });
    await expect(service.getSubscriptionById(1, 'sub-uuid-1')).rejects.toThrow(
      ForbiddenException,
    );
  });
});
