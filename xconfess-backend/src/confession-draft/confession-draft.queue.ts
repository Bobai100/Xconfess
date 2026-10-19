import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Worker, Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { ConfessionDraftService } from './confession-draft.service';

const PUBLISH_ONE_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: true,
  removeOnFail: false,
};

@Injectable()
export class ConfessionDraftQueue implements OnModuleDestroy {
  private readonly worker?: Worker;
  private readonly logger = new Logger(ConfessionDraftQueue.name);
  private readonly pendingPublishIds = new Set<string>();
  private recovered = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly draftService: ConfessionDraftService,
    @InjectQueue('confession-draft-publisher')
    private readonly queue: Queue,
  ) {
    if (this.configService.get<string>('ENABLE_BACKGROUND_JOBS') !== 'true') {
      this.logger.log(
        'Confession draft publisher is disabled; set ENABLE_BACKGROUND_JOBS=true to enable it.',
      );
      return;
    }

    const redisConfig = {
      host: this.configService.get('REDIS_HOST', 'localhost'),
      port: this.configService.get('REDIS_PORT', 6379),
    };

    this.worker = new Worker(
      'confession-draft-publisher',
      async (job: Job) => {
        if (job.name === 'publish-due') {
          const ids = await this.draftService.enqueueDueDraftIds();

          let enqueued = 0;

          for (const id of ids) {
            if (this.pendingPublishIds.has(id)) {
              continue;
            }

            this.pendingPublishIds.add(id);

            try {
              await this.queue.add(
                'publish-one',
                { id },
                { ...PUBLISH_ONE_JOB_OPTIONS, jobId: `publish-one:${id}` },
              );
              enqueued += 1;
            } catch (err) {
              this.pendingPublishIds.delete(id);
              const trace = err instanceof Error ? err.stack : String(err);
              this.logger.error(
                `Failed to enqueue publish-one for draft id=${id}`,
                trace,
              );
            }
          }

          return { enqueued };
        }

        if (job.name === 'publish-one') {
          const id = job.data?.id as string;

          if (!id) {
            return;
          }

          try {
            await this.draftService.publishScheduledDraftById(id);
          } finally {
            this.pendingPublishIds.delete(id);
          }

          return;
        }
      },
      { connection: redisConfig },
    );

    this.worker.on('error', (err) => {
      const trace = err instanceof Error ? err.stack : String(err);
      this.logger.error('ConfessionDraftQueue worker error', trace);
    });

    this.worker.on('failed', (job, err) => {
      const trace = err instanceof Error ? err.stack : String(err);

      const id = job?.data?.id as string | undefined;
      if (id) {
        this.pendingPublishIds.delete(id);
      }

      this.logger.error(
        `ConfessionDraftQueue job failed: name=${job?.name} id=${job?.id} data=${JSON.stringify(job?.data ?? {})}`,
        trace,
      );
    });

    this.worker.on('ready', () => {
      if (this.recovered) {
        this.logger.log(
          'ConfessionDraftQueue worker reconnected to Redis; resuming backlog drain',
        );
      }
      this.recovered = true;
    });

    this.worker.on('stalled', (jobId) => {
      this.logger.warn(
        `ConfessionDraftQueue job stalled id=${jobId}; awaiting recovery`,
      );
    });

    void this.scheduleRecurringJob();
  }

  private async scheduleRecurringJob(): Promise<void> {
    try {
      await this.queue.add(
        'publish-due',
        {},
        {
          repeat: { pattern: '* * * * *' },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    } catch (err) {
      const trace = err instanceof Error ? err.stack : String(err);

      this.logger.error('Failed to schedule publish-due recurring job', trace);
    }
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue.close();
    this.pendingPublishIds.clear();
  }
}