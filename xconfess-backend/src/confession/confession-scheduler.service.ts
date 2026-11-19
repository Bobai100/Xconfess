import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, DataSource } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AnonymousConfession } from './entities/confession.entity';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DateTime } from 'luxon';

@Injectable()
export class ConfessionSchedulerService {
  private readonly logger = new Logger(ConfessionSchedulerService.name);

  constructor(
    @InjectRepository(AnonymousConfession)
    private confessionRepository: Repository<AnonymousConfession>,
    private readonly dataSource: DataSource,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async publishScheduledConfessions() {
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AnonymousConfession);
      const now = new Date();

      const scheduledConfessions = await repo
        .createQueryBuilder('confession')
        .setLock('pessimistic_write')
        .where('confession.status = :status', { status: 'scheduled' })
        .andWhere('confession.publishAt <= :now', { now })
        .getMany();

      for (const confession of scheduledConfessions) {
        try {
          const result = await repo
            .createQueryBuilder()
            .update(AnonymousConfession)
            .set({
              status: 'published',
              created_at: now,
            })
            .where('id = :id', { id: confession.id })
            .andWhere('status = :status', { status: 'scheduled' })
            .execute();

          if (result.affected && result.affected > 0) {
            this.logger.log(
              `Published scheduled confession id=${confession.id} publishAt=${confession.publishAt?.toISOString()}`,
            );
          } else {
            this.logger.warn(
              `Skipped already-published confession id=${confession.id} (status no longer 'scheduled')`,
            );
          }
        } catch (error) {
          this.logger.error(
            `Failed to publish scheduled confession id=${confession.id}: ${error instanceof Error ? error.message : String(error)}`,
            error instanceof Error ? error.stack : undefined,
          );
        }
      }
    });
  }

  async scheduleConfession(
    confessionId: string,
    publishAt: string | Date,
    timezone?: string,
    userId?: number,
  ): Promise<AnonymousConfession> {
    const confession = await this.confessionRepository.findOne({
      where: { id: confessionId },
    });

    if (!confession) {
      throw new NotFoundException('Confession not found');
    }

    if (userId !== undefined) {
      const ownerLink = await this.confessionRepository
        .createQueryBuilder('confession')
        .innerJoin('confession.anonymousUser', 'anonymousUser')
        .innerJoin('anonymousUser.userLinks', 'link')
        .where('confession.id = :id', { id: confessionId })
        .andWhere('link.userId = :userId', { userId })
        .getOne();
      if (!ownerLink) throw new ForbiddenException('Not authorized');
    }

    const instant = publishAt instanceof Date
      ? DateTime.fromJSDate(publishAt)
      : timezone
        ? DateTime.fromISO(publishAt, { zone: timezone })
        : DateTime.fromISO(publishAt, { setZone: true });
    if (!instant.isValid) {
      throw new BadRequestException('publishAt or timezone is invalid');
    }
    const publishDate = instant.toUTC().toJSDate();
    if (publishDate <= new Date()) {
      throw new BadRequestException('Publish date must be in the future');
    }

    confession.status = 'scheduled';
    confession.publishAt = publishDate;
    confession.publishTimezone = timezone ?? null;

    return this.confessionRepository.save(confession);
  }

  async cancelSchedule(confessionId: string): Promise<AnonymousConfession> {
    const confession = await this.confessionRepository.findOne({
      where: { id: confessionId },
    });

    if (!confession) {
      throw new Error('Confession not found');
    }

    confession.status = 'draft';
    confession.publishAt = null;

    return this.confessionRepository.save(confession);
  }

  async getScheduledConfessions(
    userId: string,
  ): Promise<AnonymousConfession[]> {
    return this.confessionRepository.find({
      where: {
        anonymousUserId: userId,
        status: 'scheduled',
      },
      order: {
        publishAt: 'ASC',
      },
    });
  }
}
