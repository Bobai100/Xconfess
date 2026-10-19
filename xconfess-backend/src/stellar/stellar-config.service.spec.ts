import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StellarConfigService } from './stellar-config.service';

describe('StellarConfigService - network isolation', () => {
  const buildService = async (env: Record<string, string | undefined>) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StellarConfigService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => env[key]),
          },
        },
      ],
    }).compile();

    return module.get<StellarConfigService>(StellarConfigService);
  };

  const baseMainnetEnv = (): Record<string, string | undefined> => ({
    STELLAR_NETWORK: 'mainnet',
    STELLAR_HORIZON_URL: 'https://horizon.stellar.org',
    STELLAR_SOROBAN_RPC_URL: 'https://soroban.stellar.org',
    STELLAR_NETWORK_PASSPHRASE: 'Public Global Stellar Network ; September 2015',
    STELLAR_CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    STELLAR_SIGNER_SECRET: 'SDAUR...MAINNET',
    STELLAR_SIGNER_PUBLIC_KEY: 'GDAUR...MAINNET',
  });

  const baseTestnetEnv = (): Record<string, string | undefined> => ({
    STELLAR_NETWORK: 'testnet',
    STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    STELLAR_SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
    STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    STELLAR_CONTRACT_ID: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4',
    STELLAR_SIGNER_SECRET: 'SDAUR...TESTNET',
    STELLAR_SIGNER_PUBLIC_KEY: 'GDAUR...TESTNET',
  });

  describe('positive path', () => {
    it('accepts a fully consistent mainnet configuration unit', async () => {
      const service = await buildService(baseMainnetEnv());
      expect(() => service.validateNetworkIsolation()).not.toThrow();
      expect(service.getNetwork()).toBe('mainnet');
    });

    it('accepts a fully consistent testnet configuration unit', async () => {
      const service = await buildService(baseTestnetEnv());
      expect(() => service.validateNetworkIsolation()).not.toThrow();
      expect(service.getNetwork()).toBe('testnet');
    });
  });

  describe('network vs endpoint mismatch', () => {
    it('rejects mainnet network pointed at a testnet Horizon endpoint', async () => {
      const env = baseMainnetEnv();
      env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
      const service = await buildService(env);
      expect(() => service.validateNetworkIsolation()).toThrow(
        /STELLAR_HORIZON_URL.*testnet.*mainnet/i,
      );
    });

    it('rejects mainnet network pointed at a testnet Soroban RPC endpoint', async () => {
      const env = baseMainnetEnv();
      env.STELLAR_SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      const service = await buildService(env);
      expect(() => service.validateNetworkIsolation()).toThrow(
        /STELLAR_SOROBAN_RPC_URL.*testnet.*mainnet/i,
      );
    });

    it('rejects testnet network pointed at a mainnet Horizon endpoint', async () => {
      const env = baseTestnetEnv();
      env.STELLAR_HORIZON_URL = 'https://horizon.stellar.org';
      const service = await buildService(env);
      expect(() => service.validateNetworkIsolation()).toThrow(
        /STELLAR_HORIZON_URL.*mainnet.*testnet/i,
      );
    });

    it('rejects testnet network pointed at a mainnet Soroban RPC endpoint', async () => {
      const env = baseTestnetEnv();
      env.STELLAR_SOROBAN_RPC_URL = 'https://soroban.stellar.org';
      const service = await buildService(env);
      expect(() => service.validateNetworkIsolation()).toThrow(
        /STELLAR_SOROBAN_RPC_URL.*mainnet.*testnet/i,
      );
    });

    it('rejects a network passphrase that does not match the configured network', async () => {
      const env = baseMainnetEnv();
      env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
      const service = await buildService(env);
      expect(() => service.validateNetworkIsolation()).toThrow(
        /STELLAR_NETWORK_PASSPHRASE.*mainnet/i,
      );
    });
  });

  describe('network vs contract ID mismatch', () => {
    it('rejects a contract ID that is not valid for the configured network', async () => {
      const env = baseMainnetEnv();
      env.STELLAR_CONTRACT_ID = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4';
      const service = await buildService(env);
      expect(() => service.validateNetworkIsolation()).toThrow(
        /STELLAR_CONTRACT_ID.*mainnet/i,
      );
    });

    it('rejects a malformed contract ID', async () => {
      const env = baseMainnetEnv();
      env.STELLAR_CONTRACT_ID = 'not-a-valid-contract-id';
      const service = await buildService(env);
      expect(() => service.validateNetworkIsolation()).toThrow(
        /STELLAR_CONTRACT_ID/i,
      );
    });

    it('rejects a missing contract ID', async () => {
      const env = baseMainnetEnv();
      delete env.STELLAR_CONTRACT_ID;
      const service = await buildService(env);
      expect(() => service.validateNetworkIsolation()).toThrow(
        /STELLAR_CONTRACT_ID.*required/i,
      );
    });
  });

  describe('network vs signer metadata mismatch', () => {
    it('rejects a signer secret tagged for testnet on a mainnet deployment', async () => {
      const env = baseMainnetEnv();
      env.STELLAR_SIGNER_SECRET = 'SDAUR...TESTNET';
      const service = await buildService(env);
      expect(() => service.validateNetworkIsolation()).toThrow(
        /STELLAR_SIGNER_SECRET.*testnet.*mainnet/i,
      );
    });

    it('rejects a signer public key tagged for mainnet on a testnet deployment', async () => {
      const env = baseTestnetEnv();
      env.STELLAR_SIGNER_PUBLIC_KEY = 'GDAUR...MAINNET';
      const service = await buildService(env);
      expect(() => service.validateNetworkIsolation()).toThrow(
        /STELLAR_SIGNER_PUBLIC_KEY.*mainnet.*testnet/i,
      );
    });

    it('rejects a signer secret that does not match the configured signer public key', async () => {
      const env = baseMainnetEnv();
      env.STELLAR_SIGNER_PUBLIC_KEY = 'GDAUR...DIFFERENT';
      const service = await buildService(env);
      expect(() => service.validateNetworkIsolation()).toThrow(
        /STELLAR_SIGNER_SECRET.*STELLAR_SIGNER_PUBLIC_KEY/i,
      );
    });

    it('rejects a missing signer secret on a production (mainnet) deployment', async () => {
      const env = baseMainnetEnv();
      delete env.STELLAR_SIGNER_SECRET;
      const service = await buildService(env);
      expect(() => service.validateNetworkIsolation()).toThrow(
        /STELLAR_SIGNER_SECRET.*required/i,
      );
    });
  });

  describe('startup failure semantics', () => {
    it('fails startup with an actionable error listing the offending keys', async () => {
      const env = baseMainnetEnv();
      env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
      env.STELLAR_SIGNER_SECRET = 'SDAUR...TESTNET';
      const service = await buildService(env);

      let error: Error | undefined;
      try {
        service.onModuleInit();
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeDefined();
      expect(error?.message).toMatch(/STELLAR_HORIZON_URL/);
      expect(error?.message).toMatch(/STELLAR_SIGNER_SECRET/);
      expect(error?.message).toMatch(/mainnet/);
    });

    it('does not fail startup for a consistent configuration unit', async () => {
      const service = await buildService(baseMainnetEnv());
      expect(() => service.onModuleInit()).not.toThrow();
    });
  });
});