import { describe, it, expect, vi } from 'vitest';
import { createRequestDedup } from './requestDedup';

describe('requestDedup', () => {
  it('coalesces identical in-flight requests for the same identity', async () => {
    const dedup = createRequestDedup();
    let resolve!: (value: string) => void;
    const fn = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    );

    const a = dedup.dedupe('users/me', fn, { identity: 'user-1' });
    const b = dedup.dedupe('users/me', fn, { identity: 'user-1' });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(dedup.size()).toBe(1);

    resolve('payload');
    await expect(a).resolves.toBe('payload');
    await expect(b).resolves.toBe('payload');
    expect(dedup.size()).toBe(0);
  });

  it('does not share user-specific data across identities', async () => {
    const dedup = createRequestDedup();
    const fnA = vi.fn(async () => 'a');
    const fnB = vi.fn(async () => 'b');

    const [a, b] = await Promise.all([
      dedup.dedupe('users/me', fnA, { identity: 'user-1' }),
      dedup.dedupe('users/me', fnB, { identity: 'user-2' }),
    ]);

    expect(a).toBe('a');
    expect(b).toBe('b');
    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).toHaveBeenCalledTimes(1);
  });

  it('does not coalesce when identity is missing', async () => {
    const dedup = createRequestDedup();
    const fn = vi.fn(async () => 'x');

    await Promise.all([
      dedup.dedupe('users/me', fn),
      dedup.dedupe('users/me', fn),
    ]);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(dedup.size()).toBe(0);
  });

  it('rejects invalid keys without polluting the cache', async () => {
    const dedup = createRequestDedup();
    const fn = vi.fn(async () => 'x');

    await expect(dedup.dedupe('', fn, { identity: 'user-1' })).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
    expect(dedup.size()).toBe(0);
  });

  it('clears the cache entry after a failed request so retries work', async () => {
    const dedup = createRequestDedup();
    const failing = vi.fn(async () => {
      throw new Error('boom');
    });

    await expect(dedup.dedupe('users/me', failing, { identity: 'user-1' })).rejects.toThrow(
      'boom',
    );
    expect(dedup.size()).toBe(0);

    const retry = vi.fn(async () => 'ok');
    await expect(dedup.dedupe('users/me', retry, { identity: 'user-1' })).resolves.toBe('ok');
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
