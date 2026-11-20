import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { WebhookSubscription } from './entities/webhook-subscription.entity';
import {
  WebhookDelivery,
  WebhookDeliveryStatus,
} from './entities/webhook-delivery.entity';
import {
  CreateWebhookSubscriptionDto,
  UpdateWebhookSubscriptionDto,
} from './dto/webhook-subscription.dto';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    @InjectRepository(WebhookSubscription)
    private readonly subscriptionRepo: Repository<WebhookSubscription>,
    @InjectRepository(WebhookDelivery)
    private readonly deliveryRepo: Repository<WebhookDelivery>,
  ) {}

  generateSecret(): string {
    return `whsec_${crypto.randomBytes(24).toString('hex')}`;
  }

  maskSecret(secret: string): string {
    if (!secret || secret.length < 12) return 'whsec_***';
    return `${secret.substring(0, 10)}...${secret.substring(secret.length - 4)}`;
  }

  computeSignature(payload: string, secret: string, timestamp: number): string {
    const signaturePayload = `${timestamp}.${payload}`;
    return crypto
      .createHmac('sha256', secret)
      .update(signaturePayload)
      .digest('hex');
  }

  async createSubscription(
    userId: number,
    dto: CreateWebhookSubscriptionDto,
  ): Promise<{ subscription: WebhookSubscription; rawSecret: string }> {
    const rawSecret = this.generateSecret();
    const subscription = this.subscriptionRepo.create({
      userId,
      targetUrl: dto.targetUrl,
      secret: rawSecret,
      events: dto.events,
      description: dto.description,
      isActive: true,
    });

    const saved = await this.subscriptionRepo.save(subscription);
    return { subscription: saved, rawSecret };
  }

  async getSubscriptions(userId: number): Promise<Partial<WebhookSubscription>[]> {
    const subs = await this.subscriptionRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    return subs.map((sub) => ({
      ...sub,
      secret: this.maskSecret(sub.secret),
    }));
  }

  async getSubscriptionById(
    userId: number,
    id: string,
  ): Promise<WebhookSubscription> {
    const sub = await this.subscriptionRepo.findOne({
      where: { id },
    });

    if (!sub) {
      throw new NotFoundException(`Webhook subscription with id ${id} not found`);
    }

    if (sub.userId !== userId) {
      throw new ForbiddenException(
        'You are not authorized to access this webhook subscription',
      );
    }

    return sub;
  }

  async updateSubscription(
    userId: number,
    id: string,
    dto: UpdateWebhookSubscriptionDto,
  ): Promise<WebhookSubscription> {
    const sub = await this.getSubscriptionById(userId, id);

    if (dto.targetUrl !== undefined) sub.targetUrl = dto.targetUrl;
    if (dto.events !== undefined) sub.events = dto.events;
    if (dto.isActive !== undefined) sub.isActive = dto.isActive;
    if (dto.description !== undefined) sub.description = dto.description;

    return this.subscriptionRepo.save(sub);
  }

  async rotateSecret(
    userId: number,
    id: string,
  ): Promise<{ newSecret: string; rotatedAt: Date }> {
    const sub = await this.getSubscriptionById(userId, id);
    const newSecret = this.generateSecret();
    const rotatedAt = new Date();

    sub.secret = newSecret;
    sub.rotatedAt = rotatedAt;

    await this.subscriptionRepo.save(sub);
    return { newSecret, rotatedAt };
  }

  async deleteSubscription(userId: number, id: string): Promise<void> {
    const sub = await this.getSubscriptionById(userId, id);
    await this.subscriptionRepo.remove(sub);
  }

  async triggerEvent(
    eventType: string,
    payload: Record<string, any>,
    userId?: number,
  ): Promise<WebhookDelivery[]> {
    const query = this.subscriptionRepo
      .createQueryBuilder('sub')
      .where('sub.is_active = :active', { active: true });

    if (userId) {
      query.andWhere('sub.user_id = :userId', { userId });
    }

    const allSubs = await query.getMany();
    const matchingSubs = allSubs.filter(
      (sub) => sub.events.includes(eventType) || sub.events.includes('*'),
    );

    const deliveries: WebhookDelivery[] = [];
    const eventId = crypto.randomUUID();

    for (const sub of matchingSubs) {
      const delivery = this.deliveryRepo.create({
        subscriptionId: sub.id,
        eventId,
        eventType,
        payload,
        status: WebhookDeliveryStatus.PENDING,
        attempts: 0,
        maxAttempts: 3,
      });

      const saved = await this.deliveryRepo.save(delivery);
      deliveries.push(saved);

      // Async dispatch without blocking caller
      this.executeDelivery(saved.id, sub).catch((err) =>
        this.logger.error(`Failed to execute webhook delivery ${saved.id}: ${err.message}`),
      );
    }

    return deliveries;
  }

  async executeDelivery(
    deliveryId: string,
    providedSub?: WebhookSubscription,
  ): Promise<WebhookDelivery> {
    const delivery = await this.deliveryRepo.findOne({
      where: { id: deliveryId },
      relations: ['subscription'],
    });

    if (!delivery) {
      throw new NotFoundException(`Delivery ${deliveryId} not found`);
    }

    const sub = providedSub || delivery.subscription;
    if (!sub || !sub.isActive) {
      delivery.status = WebhookDeliveryStatus.FAILED;
      delivery.lastError = 'Subscription not active or deleted';
      delivery.completedAt = new Date();
      return this.deliveryRepo.save(delivery);
    }

    delivery.attempts += 1;
    const timestamp = Math.floor(Date.now() / 1000);
    const stringifiedPayload = JSON.stringify(delivery.payload);
    const signature = this.computeSignature(stringifiedPayload, sub.secret, timestamp);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(sub.targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Id': delivery.eventId,
          'X-Webhook-Event': delivery.eventType,
          'X-Webhook-Timestamp': timestamp.toString(),
          'X-Webhook-Signature': `t=${timestamp},v1=${signature}`,
          'User-Agent': 'Xconfess-Outbound-Webhook/1.0',
        },
        body: stringifiedPayload,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      delivery.statusCode = response.status;

      if (response.ok) {
        delivery.status = WebhookDeliveryStatus.SUCCESS;
        delivery.completedAt = new Date();
        delivery.nextRetryAt = undefined;
        delivery.lastError = undefined;
      } else {
        throw new Error(`HTTP status ${response.status}`);
      }
    } catch (err: any) {
      delivery.lastError = err.message || 'Webhook delivery network error';
      if (delivery.attempts < delivery.maxAttempts) {
        delivery.status = WebhookDeliveryStatus.RETRYING;
        // Bounded exponential backoff: 1 min, 5 min, 15 min
        const delays = [60_000, 300_000, 900_000];
        const delayMs = delays[delivery.attempts - 1] || 900_000;
        delivery.nextRetryAt = new Date(Date.now() + delayMs);
      } else {
        delivery.status = WebhookDeliveryStatus.FAILED;
        delivery.completedAt = new Date();
        delivery.nextRetryAt = undefined;
      }
    }

    return this.deliveryRepo.save(delivery);
  }

  async getDeliveries(
    userId: number,
    subscriptionId: string,
  ): Promise<WebhookDelivery[]> {
    await this.getSubscriptionById(userId, subscriptionId);
    return this.deliveryRepo.find({
      where: { subscriptionId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  async redeliver(userId: number, deliveryId: string): Promise<WebhookDelivery> {
    const delivery = await this.deliveryRepo.findOne({
      where: { id: deliveryId },
      relations: ['subscription'],
    });

    if (!delivery) {
      throw new NotFoundException(`Delivery ${deliveryId} not found`);
    }

    if (delivery.subscription.userId !== userId) {
      throw new ForbiddenException(
        'You are not authorized to redeliver this webhook',
      );
    }

    delivery.attempts = 0;
    delivery.status = WebhookDeliveryStatus.PENDING;
    delivery.lastError = undefined;
    delivery.completedAt = undefined;
    delivery.nextRetryAt = undefined;

    await this.deliveryRepo.save(delivery);
    return this.executeDelivery(deliveryId, delivery.subscription);
  }
}
