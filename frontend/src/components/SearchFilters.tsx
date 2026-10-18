import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Deep-linkable filter and sort state for search, feeds, admin queues, and
 * analytics views.
 *
 * The URL is the source of truth: validated view state is encoded into the
 * query string, legacy/backward-compatible formats still resolve, and any
 * malformed or unknown value falls back safely to privacy-safe defaults
 * without throwing.
 */

export type SortDirection = 'asc' | 'desc';

export interface FilterOption {
  /** Stable key used in the URL, e.g. `status`. */
  key: string;
  /** Human readable label rendered in the UI. */
  label: string;
  /** Allowed values. Anything else is dropped during parsing. */
  options: string[];
  /** Value used when the param is missing or invalid. */
  defaultValue?: string;
}

export interface SortOption {
  /** Stable key used in the URL, e.g. `created_at`. */
  key: string;
  label: string;
}

export interface ViewState {
  filters: Record<string, string>;
  sort: string;
  direction: SortDirection;
  /** Free-text query. Never contains sensitive values by default. */
  query: string;
  /**
   * When true, personal ranking features are bypassed and results are
   * non-personalized. Persisted in the URL so the preference survives
   * reloads and is explicit in shared links.
   */
  personalized: boolean;
}

export interface SearchFiltersProps {
  /** Filter definitions; drives both parsing and rendering. */
  filters: FilterOption[];
  /** Sortable fields. */
  sortOptions: SortOption[];
  /** Default sort key when the URL omits or corrupts it. */
  defaultSort?: string;
  /** Default sort direction. */
  defaultDirection?: SortDirection;
  /** Called whenever the validated state changes (e.g. to refetch). */
  onChange?: (state: ViewState) => void;
  /**
   * When true, push a new history entry per change so back/forward walks
   * through filter states. When false (default) the URL is replaced, keeping
   * history clean for high-frequency typing.
   */
  pushHistory?: boolean;
  /** Optional className passthrough. */
  className?: string;
  /**
   * Optional number of results matching the current filters. When provided it
   * is announced through the polite live region alongside the active filter
   * count so screen-reader users hear the effect of each change.
   */
  resultCount?: number;
}

const SORT_PARAM = 'sort';
const DIRECTION_PARAM = 'dir';
const QUERY_PARAM = 'q';
const PERSONALIZED_PARAM = 'personalized';

/**
 * Parse the personalization flag. Defaults to `true` (personalized) when the
 * param is absent; only an explicit opt-out (`personalized=0|false|off|no`)
 * disables personalization. Unknown values fall back to the safe default.
 */
function parsePersonalized(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  const lower = value.trim().toLowerCase();
  if (lower === '0' || lower === 'false' || lower === 'off' || lower === 'no') {
    return false;
  }
  return true;
}

/** Keys that must never be serialized into the URL. */
const SENSITIVE_KEYS = new Set([
  'token',
  'access_token',
  'refresh_token',
  'password',
  'secret',
  'api_key',
  'apikey',
  'authorization',
  'auth',
  'session',
  'email',
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

function normalizeDirection(value: string | null | undefined): SortDirection | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower === 'asc' || lower === 'ascending') return 'asc';
  if (lower === 'desc' || lower === 'descending') return 'desc';
  return null;
}

/**
 * Parse a URLSearchParams instance into a validated ViewState.
 *
 * Backward compatibility:
 * - `sort=created_at:desc` (colon form) is accepted alongside `sort` + `dir`.
 * - `sort=-created_at` (leading minus) is treated as descending.
 * - `order` is accepted as an alias for `dir`.
 * - `query` is accepted as an alias for `q`.
 *
 * Any malformed value is ignored and replaced with the safe default.
 */
export function parseViewState(
  params: URLSearchParams,
  filters: FilterOption[],
  sortOptions: SortOption[],
  defaultSort: string,
  defaultDirection: SortDirection,
): ViewState {
  const parsedFilters: Record<string, string> = {};

  for (const filter of filters) {
    if (isSensitiveKey(filter.key)) continue;
    const raw = params.get(filter.key);
    if (raw === null) {
      if (filter.defaultValue !== undefined) {
        parsedFilters[filter.key] = filter.defaultValue;
      }
      continue;
    }
    // Support comma-separated multi-values by keeping only valid entries.
    const values = raw
      .split(',')
      .map((v) => v.trim())
      .filter((v) => filter.options.includes(v));
    if (values.length > 0) {
      parsedFilters[filter.key] = values.join(',');
    } else if (filter.defaultValue !== undefined) {
      parsedFilters[filter.key] = filter.defaultValue;
    }
  }

  const allowedSorts = new Set(sortOptions.map((s) => s.key));
  let sort = defaultSort;
  let direction = defaultDirection;

  const rawSort = params.get(SORT_PARAM);
  if (rawSort) {
    let candidate = rawSort;
    let inlineDirection: SortDirection | null = null;

    if (candidate.includes(':')) {
      const [key, dir] = candidate.split(':', 2);
      candidate = key;
      inlineDirection = normalizeDirection(dir);
    } else if (candidate.startsWith('-')) {
      candidate = candidate.slice(1);
      inlineDirection = 'desc';
    }

    if (allowedSorts.has(candidate)) {
      sort = candidate;
      if (inlineDirection) direction = inlineDirection;
    }
  }

  const rawDirection =
    normalizeDirection(params.get(DIRECTION_PARAM)) ??
    normalizeDirection(params.get('order'));
  if (rawDirection) direction = rawDirection;

  const rawQuery = params.get(QUERY_PARAM) ?? params.get('query') ?? '';
  // Cap length and strip control characters to keep URLs safe and bounded.
  const query = rawQuery.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);

  const personalized = parsePersonalized(params.get(PERSONALIZED_PARAM));

  return { filters: parsedFilters, sort, direction, query, personalized };
}

/**
 * Serialize a validated ViewState into URLSearchParams, omitting defaults and
 * any sensitive keys so shared links never leak private values.
 */
export function serializeViewState(
  state: ViewState,
  filters: FilterOption[],
  defaultSort: string,
  defaultDirection: SortDirection,
): URLSearchParams {
  const params = new URLSearchParams();

  for (const filter of filters) {
    if (isSensitiveKey(filter.key)) continue;
    const value = state.filters[filter.key];
    if (value === undefined || value === '') continue;
    if (filter.defaultValue !== undefined && value === filter.defaultValue) continue;
    params.set(filter.key, value);
  }

  if (state.sort && state.sort !== defaultSort) {
    params.set(SORT_PARAM, state.sort);
  }
  if (state.direction && state.direction !== defaultDirection) {
    params.set(DIRECTION_PARAM, state.direction);
  }
  if (state.query) {
    params.set(QUERY_PARAM, state.query);
  }
  // Only serialize the opt-out; the personalized default is omitted.
  if (state.personalized === false) {
    params.set(PERSONALIZED_PARAM, '0');
  }

  return params;
}

function readLocationSearch(): string {
  if (typeof window === 'undefined') return '';
  return window.location.search;
}

export default function SearchFilters({
  filters,
  sortOptions,
  defaultSort,
  defaultDirection = 'desc',
  onChange,
  pushHistory = false,
  className,
  resultCount,
}: SearchFiltersProps) {
  const resolvedDefaultSort = defaultSort ?? sortOptions[0]?.key ?? '';

  // Unique prefix so multiple instances on one page never collide on ids.
  const idPrefix = useRef(
    `search-filters-${Math.random().toString(36).slice(2, 9)}`,
  ).current;
  const queryId = `${idPrefix}-query`;
  const sortId = `${idPrefix}-sort`;
  const directionId = `${idPrefix}-direction`;
  const resetId = `${idPrefix}-reset`;
  const statusId = `${idPrefix}-status`;
  const filterId = (key: string) => `${idPrefix}-filter-${key}`;

  const [state, setState] = useState<ViewState>(() =>
    parseViewState(
      new URLSearchParams(readLocationSearch()),
      filters,
      sortOptions,
      resolvedDefaultSort,
      defaultDirection,
    ),
  );

  // Keep a ref to the latest onChange so the popstate listener stays stable.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const applyState = useCallback(
    (next: ViewState, mode: 'push' | 'replace') => {
      setState(next);
      onChangeRef.current?.(next);

      if (typeof window === 'undefined') return;
      const params = serializeViewState(
        next,
        filters,
        resolvedDefaultSort,
        defaultDirection,
      );
      const search = params.toString();
      const url = `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`;
      if (mode === 'push') {
        window.history.pushState({ viewState: next }, '', url);
      } else {
        window.history.replaceState({ viewState: next }, '', url);
      }
    },
    [filters, resolvedDefaultSort, defaultDirection],
  );

  // Restore state on browser back/forward navigation.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handlePopState = () => {
      const next = parseViewState(
        new URLSearchParams(readLocationSearch()),
        filters,
        sortOptions,
        resolvedDefaultSort,
        defaultDirection,
      );
      setState(next);
      onChangeRef.current?.(next);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [filters, sortOptions, resolvedDefaultSort, defaultDirection]);

  const updateFilter = useCallback(
    (key: string, value: string) => {
      const nextFilters = { ...state.filters };
      if (value) {
        nextFilters[key] = value;
      } else {
        delete nextFilters[key];
      }
      applyState({ ...state, filters: nextFilters }, pushHistory ? 'push' : 'replace');
    },
    [state, applyState, pushHistory],
  );

  const updateSort = useCallback(
    (sort: string) => {
      applyState({ ...state, sort }, 'push');
    },
    [state, applyState],
  );

  const updateDirection = useCallback(
    (direction: SortDirection) => {
      applyState({ ...state, direction }, 'push');
    },
    [state, applyState],
  );

  const updateQuery = useCallback(
    (query: string) => {
      applyState({ ...state, query }, 'replace');
    },
    [state, applyState],
  );

  const updatePersonalized = useCallback(
    (personalized: boolean) => {
      applyState({ ...state, personalized }, 'push');
    },
    [state, applyState],
  );

  // Announcement text for the polite live region. Kept in state (not derived)
  // so repeated identical resets still produce a fresh announcement.
  const [announcement, setAnnouncement] = useState('');

  const reset = useCallback(() => {
    const next: ViewState = {
      filters: filters.reduce<Record<string, string>>((acc, filter) => {
        if (filter.defaultValue !== undefined && !isSensitiveKey(filter.key)) {
          acc[filter.key] = filter.defaultValue;
        }
        return acc;
      }, {}),
      sort: resolvedDefaultSort,
      direction: defaultDirection,
      query: '',
      personalized: true,
    };
    applyState(next, 'push');
    setAnnouncement('Filters reset.');
  }, [filters, resolvedDefaultSort, defaultDirection, applyState]);

  const activeFilterCount = useMemo(
    () =>
      filters.filter((filter) => {
        const value = state.filters[filter.key];
        return value !== undefined && value !== '' && value !== filter.defaultValue;
      }).length,
    [filters, state.filters],
  );

  const hasActiveState =
    activeFilterCount > 0 ||
    state.query !== '' ||
    state.sort !== resolvedDefaultSort ||
    state.direction !== defaultDirection ||
    !state.personalized;

  // Build the status sentence announced to assistive tech. Result count is
  // only included when the caller supplies it.
  const statusText = useMemo(() => {
    const parts: string[] = [];
    parts.push(
      activeFilterCount === 0
        ? 'No active filters'
        : `${activeFilterCount} active filter${activeFilterCount === 1 ? '' : 's'}`,
    );
    if (typeof resultCount === 'number') {
      parts.push(
        `${resultCount} result${resultCount === 1 ? '' : 's'}`,
      );
    }
    return parts.join(', ');
  }, [activeFilterCount, resultCount]);

  return (
    <div className={className} role="search" aria-label="Search filters">
      <div className="search-filters__query">
        <label htmlFor={queryId} className="search-filters__label">
          Search
        </label>
        <input
          id={queryId}
          type="search"
          value={state.query}
          placeholder="Search…"
          aria-describedby={statusId}
          onChange={(event) => updateQuery(event.target.value)}
        />
      </div>

      <div className="search-filters__filters">
        {filters.map((filter) => {
          if (isSensitiveKey(filter.key)) return null;
          const value = state.filters[filter.key] ?? '';
          const controlId = filterId(filter.key);
          return (
            <div key={filter.key} className="search-filters__filter">
              <label htmlFor={controlId} className="search-filters__label">
                {filter.label}
              </label>
              <select
                id={controlId}
                value={value}
                aria-describedby={statusId}
                onChange={(event) => updateFilter(filter.key, event.target.value)}
              >
                <option value="">All</option>
                {filter.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>

      <div className="search-filters__sort">
        <label htmlFor={sortId} className="search-filters__label">
          Sort by
        </label>
        <select
          id={sortId}
          value={state.sort}
          aria-describedby={statusId}
          onChange={(event) => updateSort(event.target.value)}
        >
          {sortOptions.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
        <label htmlFor={directionId} className="search-filters__label search-filters__label--visually-hidden">
          Sort direction
        </label>
        <select
          id={directionId}
          value={state.direction}
          aria-describedby={statusId}
          onChange={(event) => updateDirection(event.target.value as SortDirection)}
        >
          <option value="asc">Ascending</option>
          <option value="desc">Descending</option>
        </select>
      </div>

      <div className="search-filters__personalization">
        <label htmlFor="search-filters-personalized" className="search-filters__label">
          <input
            id="search-filters-personalized"
            type="checkbox"
            checked={state.personalized}
            onChange={(event) => updatePersonalized(event.target.checked)}
          />
          Personalize results
        </label>
        {!state.personalized && (
          <p className="search-filters__personalization-note" role="status">
            Non-personalized mode: hidden user signals are not used for ranking.
          </p>
        )}
      </div>

      <button
        id={resetId}
        type="button"
        className="search-filters__reset"
        onClick={reset}
        disabled={!hasActiveState}
        aria-label="Reset filters"
        aria-describedby={statusId}
      >
        Reset{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
      </button>

      <p
        id={statusId}
        className="search-filters__status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {statusText}
        {announcement ? ` ${announcement}` : ''}
      </p>
    </div>
  );
}
