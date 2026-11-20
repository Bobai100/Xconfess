import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { WebhookService } from './webhook.service';
import {
  CreateWebhookSubscriptionDto,
  UpdateWebhookSubscriptionDto,
} from './dto/webhook-subscription.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('webhooks')
@UseGuards(JwtAuthGuard)
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Post('subscriptions')
  async createSubscription(
    @Request() req: any,
    @Body() dto: CreateWebhookSubscriptionDto,
  ) {
    return this.webhookService.createSubscription(req.user.id, dto);
  }

  @Get('subscriptions')
  async getSubscriptions(@Request() req: any) {
    return this.webhookService.getSubscriptions(req.user.id);
  }

  @Get('subscriptions/:id')
  async getSubscription(@Request() req: any, @Param('id') id: string) {
    return this.webhookService.getSubscriptionById(req.user.id, id);
  }

  @Patch('subscriptions/:id')
  async updateSubscription(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateWebhookSubscriptionDto,
  ) {
    return this.webhookService.updateSubscription(req.user.id, id, dto);
  }

  @Post('subscriptions/:id/rotate-secret')
  async rotateSecret(@Request() req: any, @Param('id') id: string) {
    return this.webhookService.rotateSecret(req.user.id, id);
  }

  @Delete('subscriptions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSubscription(@Request() req: any, @Param('id') id: string) {
    return this.webhookService.deleteSubscription(req.user.id, id);
  }

  @Get('subscriptions/:id/deliveries')
  async getDeliveries(@Request() req: any, @Param('id') id: string) {
    return this.webhookService.getDeliveries(req.user.id, id);
  }

  @Post('deliveries/:id/redeliver')
  async redeliver(@Request() req: any, @Param('id') id: string) {
    return this.webhookService.redeliver(req.user.id, id);
  }
}
