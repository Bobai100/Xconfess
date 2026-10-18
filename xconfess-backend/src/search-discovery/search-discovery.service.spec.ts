import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SearchDiscoveryService } from './search-discovery.service';
import { UserPreference } from '../users/entities/user-preference.entity';
import { CacheService } from '../cache/cache.service';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

describe('SearchDiscoveryService - Non-Personalized Mode', () => {
  let service: SearchDiscoveryService;
  let userPreferenceRepository: Repository<UserPreference>;
  let cacheService: CacheService;

  const mockUserPreferenceRepository = {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
  };

  const mockCacheService = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    invalidatePattern: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchDiscoveryService,
        {
          provide: getRepositoryToken(UserPreference),
          useValue: mockUserPreferenceRepository,
        },
        {
          provide: CacheService,
          useValue: mockCacheService,
        },
      ],
    }).compile();

    service = module.get<SearchDiscoveryService>(SearchDiscoveryService);
    userPreferenceRepository = module.get<Repository<UserPreference>>(
      getRepositoryToken(UserPreference),
    );
    cacheService = module.get<CacheService>(CacheService);

    jest.clearAllMocks();
  });

  describe('setNonPersonalizedMode', () => {
    it('persists the non-personalized preference for an authenticated user', async () => {
      const userId = 'user-123';
      const existingPreference = {
        id: 'pref-1',
        userId,
        nonPersonalizedMode: false,
      } as UserPreference;

      mockUserPreferenceRepository.findOne.mockResolvedValue(
        existingPreference,
      );
      mockUserPreferenceRepository.save.mockImplementation(async (pref) => pref);

      const result = await service.setNonPersonalizedMode(userId, true);

      expect(mockUserPreferenceRepository.findOne).toHaveBeenCalledWith({
        where: { userId },
      });
      expect(mockUserPreferenceRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          nonPersonalizedMode: true,
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({ nonPersonalizedMode: true }),
      );
    });

    it('creates a new preference record when none exists', async () => {
      const userId = 'user-456';
      mockUserPreferenceRepository.findOne.mockResolvedValue(null);
      mockUserPreferenceRepository.create.mockImplementation((data) => data);
      mockUserPreferenceRepository.save.mockImplementation(async (pref) => pref);

      const result = await service.setNonPersonalizedMode(userId, true);

      expect(mockUserPreferenceRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          nonPersonalizedMode: true,
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({ nonPersonalizedMode: true }),
      );
    });

    it('rejects the request when no authenticated user is provided', async () => {
      await expect(
        service.setNonPersonalizedMode(undefined as unknown as string, true),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(mockUserPreferenceRepository.save).not.toHaveBeenCalled();
    });

    it('rejects the request when the user is not authorized to modify preferences', async () => {
      const userId = 'user-789';
      const requestingUserId = 'user-999';

      await expect(
        service.setNonPersonalizedMode(userId, true, requestingUserId),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(mockUserPreferenceRepository.save).not.toHaveBeenCalled();
    });

    it('invalidates cached discovery results when the preference changes', async () => {
      const userId = 'user-123';
      mockUserPreferenceRepository.findOne.mockResolvedValue({
        id: 'pref-1',
        userId,
        nonPersonalizedMode: false,
      } as UserPreference);
      mockUserPreferenceRepository.save.mockImplementation(async (pref) => pref);

      await service.setNonPersonalizedMode(userId, true);

      expect(mockCacheService.invalidatePattern).toHaveBeenCalledWith(
        expect.stringContaining(userId),
      );
    });
  });

  describe('discover - non-personalized mode', () => {
    it('bypasses personal ranking features when the preference is enabled', async () => {
      const userId = 'user-123';
      mockUserPreferenceRepository.findOne.mockResolvedValue({
        id: 'pref-1',
        userId,
        nonPersonalizedMode: true,
      } as UserPreference);
      mockCacheService.get.mockResolvedValue(null);
      mockCacheService.set.mockResolvedValue(undefined);

      const result = await service.discover({ userId, query: 'test' });

      expect(result.personalized).toBe(false);
      expect(result.results).toBeDefined();
      expect(mockCacheService.set).toHaveBeenCalled();
    });

    it('applies personal ranking features when the preference is disabled', async () => {
      const userId = 'user-123';
      mockUserPreferenceRepository.findOne.mockResolvedValue({
        id: 'pref-1',
        userId,
        nonPersonalizedMode: false,
      } as UserPreference);
      mockCacheService.get.mockResolvedValue(null);
      mockCacheService.set.mockResolvedValue(undefined);

      const result = await service.discover({ userId, query: 'test' });

      expect(result.personalized).toBe(true);
    });

    it('remains non-personalized after cache invalidation', async () => {
      const userId = 'user-123';
      const nonPersonalizedPreference = {
        id: 'pref-1',
        userId,
        nonPersonalizedMode: true,
      } as UserPreference;

      mockUserPreferenceRepository.findOne.mockResolvedValue(
        nonPersonalizedPreference,
      );
      mockCacheService.get.mockResolvedValue(null);
      mockCacheService.set.mockResolvedValue(undefined);

      const firstResult = await service.discover({ userId, query: 'test' });
      expect(firstResult.personalized).toBe(false);

      // Simulate cache invalidation
      await service.invalidateDiscoveryCache(userId);
      expect(mockCacheService.invalidatePattern).toHaveBeenCalledWith(
        expect.stringContaining(userId),
      );

      // After invalidation, preference must still be honored
      mockCacheService.get.mockResolvedValue(null);
      const secondResult = await service.discover({ userId, query: 'test' });

      expect(secondResult.personalized).toBe(false);
      expect(mockUserPreferenceRepository.findOne).toHaveBeenCalledTimes(2);
    });

    it('does not leak personalized signals into cached non-personalized results', async () => {
      const userId = 'user-123';
      mockUserPreferenceRepository.findOne.mockResolvedValue({
        id: 'pref-1',
        userId,
        nonPersonalizedMode: true,
      } as UserPreference);
      mockCacheService.get.mockResolvedValue(null);
      mockCacheService.set.mockResolvedValue(undefined);

      await service.discover({ userId, query: 'test' });

      const cacheSetCall = mockCacheService.set.mock.calls[0];
      const cachedPayload = cacheSetCall[1];

      expect(cachedPayload.personalized).toBe(false);
      expect(cachedPayload).not.toHaveProperty('personalSignals');
    });

    it('treats missing preference as personalized by default', async () => {
      const userId = 'user-123';
      mockUserPreferenceRepository.findOne.mockResolvedValue(null);
      mockCacheService.get.mockResolvedValue(null);
      mockCacheService.set.mockResolvedValue(undefined);

      const result = await service.discover({ userId, query: 'test' });

      expect(result.personalized).toBe(true);
    });
  });
});