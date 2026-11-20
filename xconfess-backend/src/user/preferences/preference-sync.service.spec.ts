import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PreferenceSyncService } from './preference-sync.service';
import { SyncPreferencesDto } from './preference-sync.types';

describe('PreferenceSyncService (#407)', () => {
  let service: PreferenceSyncService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PreferenceSyncService],
    }).compile();

    service = module.get<PreferenceSyncService>(PreferenceSyncService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should synchronize allowed non-sensitive preferences', async () => {
    const userId = 'usr-device-1';
    const dto: SyncPreferencesDto = {
      deviceId: 'device-mobile-ios',
      items: [
        {
          key: 'theme',
          value: 'dark',
          version: 1,
          clientUpdatedAt: '2026-11-20T10:00:00.000Z',
          deviceId: 'device-mobile-ios',
        },
        {
          key: 'nsfwBlur',
          value: true,
          version: 1,
          clientUpdatedAt: '2026-11-20T10:00:00.000Z',
          deviceId: 'device-mobile-ios',
        },
      ],
    };

    const res = await service.syncPreferences(userId, dto);
    expect(res.userId).toEqual(userId);
    expect(res.items.length).toEqual(2);
    expect(res.rejectedKeys.length).toEqual(0);
  });

  it('should strictly exclude and reject device-local secrets', async () => {
    const userId = 'usr-device-1';
    const dto: SyncPreferencesDto = {
      deviceId: 'device-desktop',
      items: [
        {
          key: 'theme',
          value: 'light',
          version: 2,
          clientUpdatedAt: '2026-11-20T10:05:00.000Z',
          deviceId: 'device-desktop',
        },
        {
          key: 'pushNotificationToken',
          value: 'expo-push-token-secret-12345',
          version: 1,
          clientUpdatedAt: '2026-11-20T10:05:00.000Z',
          deviceId: 'device-desktop',
        },
        {
          key: 'deviceBiometricKey',
          value: 'biometric-private-key-blob',
          version: 1,
          clientUpdatedAt: '2026-11-20T10:05:00.000Z',
          deviceId: 'device-desktop',
        },
      ],
    };

    const res = await service.syncPreferences(userId, dto);
    expect(res.rejectedKeys).toContain('pushNotificationToken');
    expect(res.rejectedKeys).toContain('deviceBiometricKey');
    expect(res.items.find((i) => i.key === 'theme')?.value).toEqual('light');
    expect(res.items.find((i) => i.key === 'pushNotificationToken')).toBeUndefined();
  });

  it('should deterministically resolve concurrent updates based on version and timestamp', async () => {
    const userId = 'usr-concurrent-test';

    // Device A sets theme to 'dark' with version 1 at 10:00:00
    await service.syncPreferences(userId, {
      deviceId: 'device-A',
      items: [
        {
          key: 'theme',
          value: 'dark',
          version: 1,
          clientUpdatedAt: '2026-11-20T10:00:00.000Z',
          deviceId: 'device-A',
        },
      ],
    });

    // Device B sets theme to 'system' with version 2 at 10:01:00 (higher version wins)
    const resB = await service.syncPreferences(userId, {
      deviceId: 'device-B',
      items: [
        {
          key: 'theme',
          value: 'system',
          version: 2,
          clientUpdatedAt: '2026-11-20T10:01:00.000Z',
          deviceId: 'device-B',
        },
      ],
    });
    expect(resB.items.find((i) => i.key === 'theme')?.value).toEqual('system');

    // Stale Device A tries to set theme to 'light' with stale version 1 (must NOT overwrite version 2)
    const resStale = await service.syncPreferences(userId, {
      deviceId: 'device-A',
      items: [
        {
          key: 'theme',
          value: 'light',
          version: 1,
          clientUpdatedAt: '2026-11-20T10:02:00.000Z',
          deviceId: 'device-A',
        },
      ],
    });
    expect(resStale.items.find((i) => i.key === 'theme')?.value).toEqual('system');
  });

  it('should reject requests without deviceId', async () => {
    await expect(
      service.syncPreferences('usr-1', { deviceId: '', items: [] }),
    ).rejects.toThrow(BadRequestException);
  });
});
