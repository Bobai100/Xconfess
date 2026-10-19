import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { SavedSearch } from './entities/saved-search.entity';
import { SearchHistory } from './entities/search-history.entity';
import { UserDiscoveryPreference } from './entities/user-discovery-preference.entity';
import { CreateSavedSearchDto } from './dto/create-saved-search.dto';
import { SearchConfessionDto } from '../confession/dto/search-confession.dto';
import { SearchAbuseGuard } from './search-abuse.guard';

interface ExtendedSearchDto extends SearchConfessionDto {
  dateFrom?: string;
  dateTo?: string;
  sort?: 'newest' | 'oldest' | 'reactions';
}

@Injectable()
export class SearchDiscoveryService {
  constructor(
    @InjectRepository(SavedSearch)
    private savedSearchRepo: Repository<SavedSearch>,
    @InjectRepository(SearchHistory)
    private searchHistoryRepo: Repository<SearchHistory>,
    private readonly searchAbuseGuard: SearchAbuseGuard,
  ) {}


  private normalizeFilters(dto: ExtendedSearchDto): any {
    const { q, page, limit, ...filters } = dto;
    return Object.fromEntries(
      Object.entries(filters).filter(([_, v]) => v != null),
    );
  }

  private generateQueryHash(q: string, filters: any): string {
    const data = JSON.stringify(
      { q, ...filters },
      Object.keys({ q, ...filters }).sort(),
    );
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  // =========================================================
  // EXECUTE FULL TEXT SEARCH WITH FILTERS & HISTORY LOGGING
  // =========================================================
  async executeFullTextSearch(userId: number, dto: ExtendedSearchDto) {
    const q = dto.q?.trim() || '';

    // ── Abuse / cost-budget check (#84) ───────────────────────────────────────
    // Assess before any DB work. Violations are logged without raw query text.
    if (q) {
      const assessment = this.searchAbuseGuard.assess(
        q,
        dto.page ?? 1,
        dto.limit ?? 40,
      );
      if (!assessment.allowed) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Search query rejected',
          // Surface the first human-readable message; others are in violations[].
          message: assessment.violations[0]?.message ?? 'Query exceeds allowed complexity.',
          violations: assessment.violations.map((v) => ({
            code: v.code,
            message: v.message,
          })),
        });
      }
    }

    // Automatically log the entry to history if a text keyword query is passed
    if (q) {
      await this.recordSearch(userId, dto);
    }
    const manager = this.searchHistoryRepo.manager;
    const conditions: string[] = ['is_deleted = false'];
    const parameters: any[] = [];
    let paramIndex = 1;

    // Clamp limit to safe range [1, 100]; use 40 only when omitted/invalid.
    const requestedLimit =
      dto.limit === undefined || dto.limit === null ? 40 : Number(dto.limit);
    const limit = Math.min(
      Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 40, 1),
      100,
    );

    let selectFields = `id, title, body as "highlightedBody", category, reaction_count as "reactionCount", gender, created_at as "createdAt"`;
    let orderBy = `"createdAt" DESC`;

    if (q) {
      parameters.push(q);

      // Native Postgres full-text vectors parsing with clean Tailwind highlight wrappers
      selectFields = `
        id,
        title,
        category,
        reaction_count as "reactionCount",
        gender,
        created_at as "createdAt",
        ts_headline('english', body, plainto_tsquery('english', $${paramIndex}), 'StartSel=<mark class="bg-yellow-500/30 text-yellow-200 px-1 rounded font-semibold">, StopSel=</mark>, MaxWords=60') as "highlightedBody"
      `;
      conditions.push(
        `to_tsvector('english', body) @@ plainto_tsquery('english', $${paramIndex})`,
      );
      orderBy = `ts_rank(to_tsvector('english', body), plainto_tsquery('english', $${paramIndex})) DESC`;
      paramIndex++;
    }

    // Process options criteria mappings dynamically
    if (dto.dateFrom) {
      parameters.push(dto.dateFrom);
      conditions.push(`created_at >= $${paramIndex}::timestamp`);
      paramIndex++;
    }
    if (dto.dateTo) {
      parameters.push(dto.dateTo);
      conditions.push(`created_at <= $${paramIndex}::timestamp`);
      paramIndex++;
    }
    if (dto.minReactions && dto.minReactions > 0) {
      parameters.push(dto.minReactions);
      conditions.push(`reaction_count >= $${paramIndex}`);
      paramIndex++;
    }
    if (dto.gender) {
      parameters.push(dto.gender);
      conditions.push(`gender = $${paramIndex}`);
      paramIndex++;
    }

    if (dto.sort === 'oldest') orderBy = `"createdAt" ASC`;
    if (dto.sort === 'reactions') orderBy = `"reactionCount" DESC`;

    parameters.push(limit);
    const rawQuery = `
      SELECT ${selectFields}
      FROM confessions
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT $${paramIndex}
    `;

    const results = await manager.query(rawQuery, parameters);
    return { results };
  }

  async savePreset(userId: number, dto: CreateSavedSearchDto) {
    const filters = this.normalizeFilters(dto.filters as ExtendedSearchDto);
    let preset = await this.savedSearchRepo.findOne({
      where: { userId, name: dto.name },
    });

    if (preset) {
      if (preset.userId !== userId) {
        throw new NotFoundException('Saved preset not found or unauthorized');
      }
      preset.filters = filters;
      return this.savedSearchRepo.save(preset);
    }

    preset = this.savedSearchRepo.create({
      userId,
      name: dto.name,
      filters,
    });
    return this.savedSearchRepo.save(preset);
  }

  async listPresets(userId: number) {
    return this.savedSearchRepo.find({
      where: { userId },
      order: { updatedAt: 'DESC' },
    });
  }

  async deletePreset(userId: number, id: string) {
    const result = await this.savedSearchRepo.delete({ id, userId });
    // If nothing was deleted, either it doesn't exist or isn't owned by user
    if ((result as any)?.affected === 0) {
      throw new NotFoundException('Saved preset not found or unauthorized');
    }
    return result;
  }

  async recordSearch(userId: number, dto: ExtendedSearchDto) {
    const q = dto.q?.trim() || '';
    if (!q) return;
    const filters = this.normalizeFilters(dto);
    const queryHash = this.generateQueryHash(q, filters);

    const existing = await this.searchHistoryRepo.findOne({
      where: { userId, queryHash },
    });

    if (existing) {
      await this.searchHistoryRepo.save(existing);
    } else {
      const history = this.searchHistoryRepo.create({
        userId,
        query: q,
        filters,
        queryHash,
      });
      await this.searchHistoryRepo.save(history);
    }

    const count = await this.searchHistoryRepo.count({ where: { userId } });
    if (count > 20) {
      const oldest = await this.searchHistoryRepo.find({
        where: { userId },
        order: { usedAt: 'ASC' },
        take: count - 20,
      });
      if (oldest.length > 0) {
        await this.searchHistoryRepo.remove(oldest);
      }
    }
  }

  async getRecentSearches(userId: number) {
    return this.searchHistoryRepo.find({
      where: { userId },
      order: { usedAt: 'DESC' },
      take: 20,
    });
  }

  // =========================================================
  // RECOMMENDATION SAFEGUARDS, DIVERSITY & EXPLAINABILITY
  // =========================================================
  async getUserDiscoveryPreference(userId: number): Promise<UserDiscoveryPreference> {
    let pref = await this.discoveryPreferenceRepo.findOne({ where: { userId } });
    if (!pref) {
      pref = this.discoveryPreferenceRepo.create({
        userId,
        personalizationOptOut: false,
        diversityThreshold: 0.35,
        excludedCategories: [],
      });
      await this.discoveryPreferenceRepo.save(pref);
    }
    return pref;
  }

  async updateUserDiscoveryPreference(
    userId: number,
    dto: UpdateDiscoveryPreferencesDto,
  ): Promise<UserDiscoveryPreference> {
    const pref = await this.getUserDiscoveryPreference(userId);
    if (dto.personalizationOptOut !== undefined) {
      pref.personalizationOptOut = dto.personalizationOptOut;
    }
    if (dto.diversityThreshold !== undefined) {
      pref.diversityThreshold = Math.min(Math.max(dto.diversityThreshold, 0.1), 0.9);
    }
    if (dto.excludedCategories !== undefined) {
      pref.excludedCategories = dto.excludedCategories;
    }
    return this.discoveryPreferenceRepo.save(pref);
  }

  async getPersonalizedRecommendations(
    userId: number,
    limit = 20,
  ): Promise<RecommendedConfessionDto[]> {
    const preferences = await this.getUserDiscoveryPreference(userId);
    const manager = this.searchHistoryRepo.manager;
    const safeLimit = Math.min(Math.max(limit, 1), 50);

    // Personalization is only active when the user has not opted out AND the
    // feature flag is enabled. The decision is evaluated on every request
    // (after any cache lookup) so a stale personalized cache can never leak
    // personal signals once the preference or flag changes.
    const personalizationEnabled =
      this.isPersonalizationFeatureEnabled() && !preferences.personalizationOptOut;

    if (!personalizationEnabled) {
      // Non-personalized discovery mode: bypass ALL personal ranking signals
      // (search history, interests, per-user scoring) and serve a deterministic
      // baseline ordering that is identical for every user.
      const publicRows: any[] = await manager.query(
        `SELECT id, title, category, reaction_count as "reactionCount", gender, created_at as "createdAt"
         FROM anonymous_confessions
         WHERE is_deleted = false
         ORDER BY reaction_count DESC, created_at DESC, id ASC
         LIMIT $1`,
        [safeLimit * 2],
      );

      return this.applyDiversityAndExplanations(
        publicRows,
        safeLimit,
        preferences.diversityThreshold,
        preferences.excludedCategories || [],
        false,
        'Trending public discovery (personalization disabled)',
      );
    }

    // Personalization enabled: inspect recent history for topic interests
    const recentHistory = await this.getRecentSearches(userId);
    const interestedKeywords = recentHistory.map((h) => h.query.toLowerCase()).slice(0, 5);

    // Fetch candidate pool
    const candidates: any[] = await manager.query(
      `SELECT id, title, category, reaction_count as "reactionCount", gender, created_at as "createdAt"
       FROM anonymous_confessions
       WHERE is_deleted = false
       ORDER BY created_at DESC, reaction_count DESC
       LIMIT $1`,
      [safeLimit * 3],
    );

    // Score and explain candidates
    return this.applyPersonalizedRanking(
      candidates,
      interestedKeywords,
      safeLimit,
      preferences.diversityThreshold,
      preferences.excludedCategories || [],
    );
  }

  /**
   * Reads the personalization feature flag. When disabled, every user is
   * served the non-personalized baseline regardless of stored preference.
   */
  private isPersonalizationFeatureEnabled(): boolean {
    const raw = process.env.PERSONALIZATION_ENABLED;
    if (raw === undefined || raw === '') return true;
    return !['false', '0', 'off', 'no'].includes(raw.trim().toLowerCase());
  }

  private applyPersonalizedRanking(
    candidates: any[],
    keywords: string[],
    limit: number,
    diversityThreshold: number,
    excludedCategories: string[],
  ): RecommendedConfessionDto[] {
    const categoryCounts: Record<string, number> = {};
    const maxPerCategory = Math.max(1, Math.floor(limit * (1 - diversityThreshold)));
    const results: RecommendedConfessionDto[] = [];

    // Filter excluded categories
    const allowed = candidates.filter(
      (c) => !excludedCategories.includes(c.category),
    );

    for (const item of allowed) {
      if (results.length >= limit) break;

      const cat = item.category || 'general';
      const currentCatCount = categoryCounts[cat] || 0;

      // Filter bubble guard: enforce diversity constraint
      if (currentCatCount >= maxPerCategory && results.length < limit - 2) {
        continue;
      }

      const titleLower = (item.title || '').toLowerCase();
      const matchedKeyword = keywords.find((kw) => titleLower.includes(kw));

      let source: 'recent_interest' | 'global_trending' | 'diversity_fill' = 'global_trending';
      let reason = 'Popular across the community';

      if (matchedKeyword) {
        source = 'recent_interest';
        reason = `Suggested because you recently explored "${matchedKeyword}"`;
      } else if (currentCatCount === 0) {
        source = 'diversity_fill';
        reason = `Broadening your discovery with ${cat}`;
      }

      categoryCounts[cat] = currentCatCount + 1;
      results.push({
        id: item.id,
        title: item.title,
        category: cat,
        reactionCount: Number(item.reactionCount) || 0,
        gender: item.gender,
        createdAt: item.createdAt,
        explanation: {
          source,
          reason,
          category: cat,
        },
        isPersonalized: true,
      });
    }

    return results;
  }

  private applyDiversityAndExplanations(
    candidates: any[],
    limit: number,
    diversityThreshold: number,
    excludedCategories: string[],
    isPersonalized: boolean,
    defaultReason: string,
  ): RecommendedConfessionDto[] {
    const categoryCounts: Record<string, number> = {};
    const maxPerCategory = Math.max(1, Math.floor(limit * (1 - diversityThreshold)));
    const results: RecommendedConfessionDto[] = [];

    const allowed = candidates.filter(
      (c) => !excludedCategories.includes(c.category),
    );

    for (const item of allowed) {
      if (results.length >= limit) break;

      const cat = item.category || 'general';
      const currentCatCount = categoryCounts[cat] || 0;

      if (currentCatCount >= maxPerCategory && results.length < limit - 2) {
        continue;
      }

      categoryCounts[cat] = currentCatCount + 1;
      results.push({
        id: item.id,
        title: item.title,
        category: cat,
        reactionCount: Number(item.reactionCount) || 0,
        gender: item.gender,
        createdAt: item.createdAt,
        explanation: {
          source: 'global_trending',
          reason: defaultReason,
          category: cat,
        },
        isPersonalized,
      });
    }

    return results;
  }
}

