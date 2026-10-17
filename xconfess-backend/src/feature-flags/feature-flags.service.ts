import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FeatureFlag } from './entities/feature-flag.entity';
import {
  CreateFeatureFlagDto,
  UpdateFeatureFlagDto,
} from './dto/create-feature-flag.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditActionType } from '../audit-log/audit-log.entity';

export const PERSONALIZATION_FLAG = 'personalization';
export const RANKING_VERSION_FLAG = 'ranking.version';

@Injectable()
export class FeatureFlagsService {
  constructor(
    @InjectRepository(FeatureFlag)
    private featureFlagRepository: Repository<FeatureFlag>,
    @Optional()
    private auditLogService?: AuditLogService,
  ) {}

  private validateFlagName(name: string): void {
    if (!name || typeof name !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(name.trim())) {
      throw new BadRequestException(
        'Invalid feature flag name. Name must contain only letters, numbers, hyphens, underscores, and dots.',
      );
    }
  }

  private validateFlagValues(dto: {
    percentage?: number;
    userIds?: string[];
    enabled?: boolean;
  }): void {
    if (dto.percentage !== undefined) {
      if (
        typeof dto.percentage !== 'number' ||
        isNaN(dto.percentage) ||
        dto.percentage < 0 ||
        dto.percentage > 100 ||
        !Number.isInteger(dto.percentage)
      ) {
        throw new BadRequestException(
          'Invalid percentage value. Percentage must be an integer between 0 and 100.',
        );
      }
    }

    if (dto.userIds !== undefined) {
      if (
        !Array.isArray(dto.userIds) ||
        dto.userIds.some((id) => typeof id !== 'string' || id.trim() === '')
      ) {
        throw new BadRequestException(
          'Invalid userIds targeting safeguard failed. User IDs must be an array of non-empty strings.',
        );
      }
    }

    if (dto.enabled !== undefined && typeof dto.enabled !== 'boolean') {
      throw new BadRequestException(
        'Invalid enabled value. Enabled status must be a boolean.',
      );
    }
  }

  async create(
    dto: CreateFeatureFlagDto,
    actorId?: string,
  ): Promise<FeatureFlag> {
    this.validateFlagName(dto.name);
    this.validateFlagValues(dto);

    const existing = await this.findOne(dto.name);
    if (existing) {
      throw new BadRequestException(
        `Feature flag with name "${dto.name}" already exists`,
      );
    }

    const lastChangedBy = dto.lastChangedBy || actorId || 'system';
    const flag = this.featureFlagRepository.create({
      ...dto,
      lastChangedBy,
      lastChangedAt: new Date(),
    });

    const saved = await this.featureFlagRepository.save(flag);

    if (this.auditLogService) {
      await this.auditLogService.log({
        actionType: AuditActionType.FEATURE_FLAG_CREATED,
        metadata: {
          entityType: 'FeatureFlag',
          entityId: saved.id,
          flagName: saved.name,
          enabled: saved.enabled,
          percentage: saved.percentage,
          userIds: saved.userIds,
          lastChangedBy,
        },
        context: { userId: actorId },
      });
    }

    return saved;
  }

  async findAll(): Promise<FeatureFlag[]> {
    return this.featureFlagRepository.find();
  }

  async findOne(name: string): Promise<FeatureFlag | null> {
    return this.featureFlagRepository.findOne({ where: { name } });
  }

  async update(
    name: string,
    dto: UpdateFeatureFlagDto,
    actorId?: string,
  ): Promise<FeatureFlag> {
    this.validateFlagName(name);
    this.validateFlagValues(dto);

    const existing = await this.findOne(name);
    if (!existing) {
      throw new NotFoundException(`Feature flag ${name} not found`);
    }

    const previousState = {
      name: existing.name,
      description: existing.description,
      enabled: existing.enabled,
      percentage: existing.percentage,
      userIds: existing.userIds ? [...existing.userIds] : [],
      lastChangedBy: existing.lastChangedBy,
      lastChangedAt: existing.lastChangedAt,
    };

    const lastChangedBy = dto.lastChangedBy || actorId || 'system';

    if (dto.description !== undefined) existing.description = dto.description;
    if (dto.enabled !== undefined) existing.enabled = dto.enabled;
    if (dto.percentage !== undefined) existing.percentage = dto.percentage;
    if (dto.userIds !== undefined) existing.userIds = dto.userIds;
    existing.lastChangedBy = lastChangedBy;
    existing.lastChangedAt = new Date();
    existing.rollbackMetadata = {
      previousState,
      timestamp: new Date().toISOString(),
    };

    const updated = await this.featureFlagRepository.save(existing);

    if (this.auditLogService) {
      await this.auditLogService.log({
        actionType: AuditActionType.FEATURE_FLAG_UPDATED,
        metadata: {
          entityType: 'FeatureFlag',
          entityId: updated.id,
          flagName: updated.name,
          changes: dto,
          previousState,
          lastChangedBy,
        },
        context: { userId: actorId },
      });
    }

    return updated;
  }

  async rollback(name: string, actorId?: string): Promise<FeatureFlag> {
    this.validateFlagName(name);

    const existing = await this.findOne(name);
    if (!existing) {
      throw new NotFoundException(`Feature flag ${name} not found`);
    }

    if (!existing.rollbackMetadata || !existing.rollbackMetadata.previousState) {
      throw new BadRequestException(
        `No rollback metadata available for feature flag "${name}"`,
      );
    }

    const currentStateSnapshot = {
      name: existing.name,
      description: existing.description,
      enabled: existing.enabled,
      percentage: existing.percentage,
      userIds: existing.userIds ? [...existing.userIds] : [],
      lastChangedBy: existing.lastChangedBy,
      lastChangedAt: existing.lastChangedAt,
    };

    const prev = existing.rollbackMetadata.previousState;
    if (prev.description !== undefined) existing.description = prev.description;
    if (prev.enabled !== undefined) existing.enabled = prev.enabled;
    if (prev.percentage !== undefined) existing.percentage = prev.percentage;
    if (prev.userIds !== undefined) existing.userIds = prev.userIds;

    const lastChangedBy = actorId || 'system';
    existing.lastChangedBy = lastChangedBy;
    existing.lastChangedAt = new Date();
    existing.rollbackMetadata = {
      previousState: currentStateSnapshot,
      timestamp: new Date().toISOString(),
    };

    const rolledBack = await this.featureFlagRepository.save(existing);

    if (this.auditLogService) {
      await this.auditLogService.log({
        actionType: AuditActionType.FEATURE_FLAG_ROLLED_BACK,
        metadata: {
          entityType: 'FeatureFlag',
          entityId: rolledBack.id,
          flagName: rolledBack.name,
          restoredState: prev,
          lastChangedBy,
        },
        context: { userId: actorId },
      });
    }

    return rolledBack;
  }

  async delete(name: string, actorId?: string): Promise<void> {
    this.validateFlagName(name);

    const existing = await this.findOne(name);
    if (!existing) {
      throw new NotFoundException(`Feature flag ${name} not found`);
    }

    if (this.auditLogService) {
      await this.auditLogService.log({
        actionType: AuditActionType.FEATURE_FLAG_DELETED,
        metadata: {
          entityType: 'FeatureFlag',
          entityId: existing.id,
          flagName: existing.name,
          lastChangedBy: actorId || 'system',
        },
        context: { userId: actorId },
      });
    }

    await this.featureFlagRepository.delete({ name });
  }

  async isEnabled(flagName: string, userId?: string): Promise<boolean> {
    const flag = await this.findOne(flagName);

    if (!flag || !flag.enabled) {
      return false;
    }

    // Check if user is in allowlist
    if (userId && flag.userIds && flag.userIds.length > 0) {
      return flag.userIds.includes(userId);
    }

    // Percentage-based rollout
    if (flag.percentage === 100) {
      return true;
    }

    if (flag.percentage === 0) {
      return false;
    }

    // Use userId hash for consistent assignment
    if (userId) {
      const hash = this.hashCode(userId + flagName);
      return Math.abs(hash) % 100 < flag.percentage;
    }

    // Random for anonymous users
    return Math.random() * 100 < flag.percentage;
  }

  /**
   * Returns true when personalized ranking/discovery features are allowed for
   * the given user. When the flag is missing or disabled, callers MUST fall
   * back to non-personalized discovery (no hidden user signals).
   */
  async isPersonalizationEnabled(userId?: string): Promise<boolean> {
    return this.isEnabled(PERSONALIZATION_FLAG, userId);
  }

  /**
   * Ensures the personalization flag exists so operators can roll it out or
   * disable it without a manual seed step. Defaults to disabled (opt-in).
   */
  async ensurePersonalizationFlag(actorId?: string): Promise<FeatureFlag> {
    const existing = await this.findOne(PERSONALIZATION_FLAG);
    if (existing) {
      return existing;
    }

    return this.create(
      {
        name: PERSONALIZATION_FLAG,
        description:
          'Enables personalized ranking/discovery. When disabled, results are non-personalized.',
        enabled: false,
        percentage: 0,
        userIds: [],
        lastChangedBy: actorId || 'system',
      } as CreateFeatureFlagDto,
      actorId,
    );
  }

  /**
   * Returns the currently active ranking version identifier, or null when no
   * ranking version is active (e.g. disabled by the drift review path).
   */
  async getActiveRankingVersion(): Promise<string | null> {
    const flag = await this.findOne(RANKING_VERSION_FLAG);
    if (!flag || !flag.enabled) {
      return null;
    }

    const version = flag.description?.trim();
    return version ? version : null;
  }

  /**
   * Disables the active ranking version. Used by the drift review path to stop
   * serving a ranking version whose quality has drifted.
   */
  async disableRankingVersion(
    actorId?: string,
    reason?: string,
  ): Promise<FeatureFlag> {
    const existing = await this.findOne(RANKING_VERSION_FLAG);
    if (!existing) {
      throw new NotFoundException(
        `Feature flag ${RANKING_VERSION_FLAG} not found`,
      );
    }

    return this.update(
      RANKING_VERSION_FLAG,
      {
        enabled: false,
        description: reason
          ? `${existing.description ?? ''} | disabled: ${reason}`.trim()
          : existing.description,
        lastChangedBy: actorId || 'system',
      } as UpdateFeatureFlagDto,
      actorId,
    );
  }

  /**
   * Re-enables a previously disabled ranking version.
   */
  async enableRankingVersion(
    version: string,
    actorId?: string,
  ): Promise<FeatureFlag> {
    if (!version || typeof version !== 'string' || version.trim() === '') {
      throw new BadRequestException(
        'A non-empty ranking version identifier is required.',
      );
    }

    const existing = await this.findOne(RANKING_VERSION_FLAG);
    if (!existing) {
      return this.create(
        {
          name: RANKING_VERSION_FLAG,
          description: version.trim(),
          enabled: true,
          percentage: 100,
          userIds: [],
          lastChangedBy: actorId || 'system',
        } as CreateFeatureFlagDto,
        actorId,
      );
    }

    return this.update(
      RANKING_VERSION_FLAG,
      {
        enabled: true,
        description: version.trim(),
        lastChangedBy: actorId || 'system',
      } as UpdateFeatureFlagDto,
      actorId,
    );
  }

  private hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return hash;
  }
}
