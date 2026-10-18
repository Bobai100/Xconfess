import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Deep-linkable view state (filters + sort) encoded in the URL query string.
 *
 * Design goals (issue #34):
 * - Reload and shared links reproduce the exact view state.
 * - Backward-compatible parsing: legacy/unknown params are tolerated and
 *   normalized rather than throwing.
 * - Privacy-safe defaults: only allow-listed keys are ever written to the URL,
 *   and values are validated/coerced before serialization so sensitive or
 *   malformed input never leaks into a shareable link.
 * - Intentional history behavior: filter/sort changes use `replaceState` by
 *   default (no history spam) while explicit navigation can opt into `pushState`.
 */

export type UrlStateValue = string | number | boolean | null | undefined;

export type UrlStateSchema<T extends Record<string, UrlStateValue>> = {
  [K in keyof T]: {
    /** Query-string key. Defaults to the state key. */
    key?: string;
    /** Legacy keys that should still resolve to this field. */
    aliases?: string[];
    /** Coerce a raw string into the typed value, or return undefined to reject. */
    parse?: (raw: string) => T[K] | undefined;
    /** Serialize a typed value into a string, or return undefined to omit it. */
    serialize?: (value: T[K]) => string | undefined;
    /** Value used when the param is missing or invalid. */
    defaultValue: T[K];
  };
};

export type UseUrlStateOptions = {
  /** Replace (default) or push a new history entry when state changes. */
  history?: 'replace' | 'push';
};

const isBrowser = typeof window !== 'undefined';

function readSearch(): string {
  if (!isBrowser) return '';
  return window.location.search;
}

function parseRawParams(search: string): Map<string, string> {
  const params = new Map<string, string>();
  const query = search.startsWith('?') ? search.slice(1) : search;
  if (!query) return params;
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? '' : pair.slice(eq + 1);
    let key = rawKey;
    let value = rawValue;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      value = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch {
      // Malformed percent-encoding: fall back to the raw (undecoded) pair.
    }
    if (!params.has(key)) params.set(key, value);
  }
  return params;
}

function defaultParse(raw: string): string | undefined {
  return raw === '' ? undefined : raw;
}

function defaultSerialize(value: UrlStateValue): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'boolean') return value ? '1' : '0';
  const str = String(value);
  return str === '' ? undefined : str;
}

function resolveField<T extends Record<string, UrlStateValue>>(
  schema: UrlStateSchema<T>,
  params: Map<string, string>,
  field: keyof T,
): T[keyof T] {
  const config = schema[field];
  const keys = [config.key ?? String(field), ...(config.aliases ?? [])];
  const parse = config.parse ?? (defaultParse as (raw: string) => T[keyof T] | undefined);
  for (const key of keys) {
    if (!params.has(key)) continue;
    const raw = params.get(key) as string;
    try {
      const parsed = parse(raw);
      if (parsed !== undefined) return parsed;
    } catch {
      // Invalid value: fall through to the next alias / default.
    }
  }
  return config.defaultValue;
}

/**
 * Validate a typed value against the schema field before it is written to the
 * URL. Values that fail serialization (or that serialize to an empty string)
 * are rejected so malformed/private state never reaches a shareable link.
 */
function validateField<T extends Record<string, UrlStateValue>>(
  schema: UrlStateSchema<T>,
  field: keyof T,
  value: T[keyof T],
): T[keyof T] {
  const config = schema[field];
  const serialize = config.serialize ?? (defaultSerialize as (v: T[keyof T]) => string | undefined);
  const parse = config.parse ?? (defaultParse as (raw: string) => T[keyof T] | undefined);
  try {
    const encoded = serialize(value);
    if (encoded === undefined) return config.defaultValue;
    // Round-trip through parse to guarantee the value is representable.
    const reparsed = parse(encoded);
    return reparsed === undefined ? config.defaultValue : reparsed;
  } catch {
    return config.defaultValue;
  }
}

function buildSearch<T extends Record<string, UrlStateValue>>(
  schema: UrlStateSchema<T>,
  state: T,
): string {
  const params = new URLSearchParams();
  for (const field of Object.keys(schema) as (keyof T)[]) {
    const config = schema[field];
    const value = state[field];
    const serialize = config.serialize ?? (defaultSerialize as (v: T[keyof T]) => string | undefined);
    let encoded: string | undefined;
    try {
      encoded = serialize(value);
    } catch {
      encoded = undefined;
    }
    if (encoded === undefined) continue;
    params.set(config.key ?? String(field), encoded);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * Bind a validated subset of view state to the URL query string.
 *
 * @example
 * const [state, setState] = useUrlState(
 *   { q: { defaultValue: '' }, sort: { defaultValue: 'recent', aliases: ['order'] } },
 *   { history: 'replace' },
 * );
 */
export function useUrlState<T extends Record<string, UrlStateValue>>(
  schema: UrlStateSchema<T>,
  options: UseUrlStateOptions = {},
): [T, (patch: Partial<T>, opts?: UseUrlStateOptions) => void] {
  const schemaRef = useRef(schema);
  schemaRef.current = schema;

  const readState = useCallback((): T => {
    const params = parseRawParams(readSearch());
    const next = {} as T;
    for (const field of Object.keys(schemaRef.current) as (keyof T)[]) {
      next[field] = resolveField(schemaRef.current, params, field);
    }
    return next;
  }, []);

  const [state, setState] = useState<T>(readState);

  // Keep state in sync with external navigation (back/forward, manual edits).
  useEffect(() => {
    if (!isBrowser) return;
    const onPopState = () => setState(readState());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [readState]);

  const update = useCallback(
    (patch: Partial<T>, opts: UseUrlStateOptions = {}) => {
      setState((prev) => {
        const merged = { ...prev, ...patch };
        // Normalize every field through the schema so invalid values fall back
        // to defaults and unknown/private keys are never serialized.
        const next = {} as T;
        for (const field of Object.keys(schemaRef.current) as (keyof T)[]) {
          next[field] = validateField(schemaRef.current, field, merged[field]);
        }
        if (isBrowser) {
          const search = buildSearch(schemaRef.current, next);
          const url = `${window.location.pathname}${search}${window.location.hash}`;
          const mode = opts.history ?? options.history ?? 'replace';
          if (mode === 'push') {
            window.history.pushState(null, '', url);
          } else {
            window.history.replaceState(null, '', url);
          }
        }
        return next;
      });
    },
    [options.history],
  );

  return useMemo(() => [state, update], [state, update]);
}

export default useUrlState;
