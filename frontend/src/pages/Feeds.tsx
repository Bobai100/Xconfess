import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { Feed, FeedSort } from '../lib/api';
import {
  DEFAULT_SORT,
  DEFAULT_TAGS,
  SORT_OPTIONS,
  parseSort,
  parseTags,
  serializeTags,
} from '../lib/feedFilters';

function pluralizeFeeds(count: number): string {
  return count === 1 ? '1 feed' : `${count} feeds`;
}

export default function Feeds() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const sort = useMemo(() => parseSort(searchParams.get('sort')), [searchParams]);
  const tags = useMemo(() => parseTags(searchParams.get('tags')), [searchParams]);

  const updateParams = useCallback(
    (next: { sort?: FeedSort; tags?: string[] }, replace = false) => {
      const params = new URLSearchParams(searchParams);
      const nextSort = next.sort ?? sort;
      const nextTags = next.tags ?? tags;

      if (nextSort === DEFAULT_SORT) {
        params.delete('sort');
      } else {
        params.set('sort', nextSort);
      }

      const serializedTags = serializeTags(nextTags);
      if (serializedTags) {
        params.set('tags', serializedTags);
      } else {
        params.delete('tags');
      }

      setSearchParams(params, { replace });
    },
    [searchParams, setSearchParams, sort, tags],
  );

  const handleSortChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      updateParams({ sort: parseSort(event.target.value) });
    },
    [updateParams],
  );

  const handleTagToggle = useCallback(
    (tag: string) => {
      const normalized = tag.trim().toLowerCase();
      const nextTags = tags.includes(normalized)
        ? tags.filter((t) => t !== normalized)
        : [...tags, normalized];
      updateParams({ tags: nextTags });
    },
    [tags, updateParams],
  );

  const handleClearFilters = useCallback(() => {
    updateParams({ sort: DEFAULT_SORT, tags: DEFAULT_TAGS });
    setAnnouncement('Filters cleared. Showing all feeds.');
  }, [updateParams]);

  const hasActiveFilters = sort !== DEFAULT_SORT || tags.length > 0;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .getFeeds({ sort, tags })
      .then((data) => {
        if (!cancelled) {
          setFeeds(data);
          setAnnouncement(
            data.length === 0
              ? 'No feeds match these filters.'
              : `Showing ${pluralizeFeeds(data.length)}.`,
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError('Unable to load feeds. Please try again.');
          setAnnouncement('Unable to load feeds. Please try again.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sort, tags]);

  return (
    <div className="feeds-page">
      <header className="feeds-header">
        <h1>Feeds</h1>
        <div className="feeds-controls">
          <label htmlFor="feed-sort">Sort feeds by</label>
          <select
            id="feed-sort"
            value={sort}
            onChange={handleSortChange}
            aria-describedby="feed-sort-hint"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <span id="feed-sort-hint" className="visually-hidden">
            Changes the order of the feed list.
          </span>
          {hasActiveFilters && (
            <button type="button" onClick={handleClearFilters}>
              Clear filters
            </button>
          )}
        </div>
      </header>

      <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>

      {tags.length > 0 && (
        <ul className="feeds-active-tags" aria-label="Active tag filters">
          {tags.map((tag) => (
            <li key={tag}>
              <button
                type="button"
                onClick={() => handleTagToggle(tag)}
                aria-label={`Remove tag filter ${tag}`}
              >
                {tag} ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {loading && <p>Loading feeds…</p>}
      {error && <p role="alert">{error}</p>}

      {!loading && !error && feeds.length === 0 && (
        <p className="feeds-empty">No feeds match these filters.</p>
      )}

      {!loading && !error && feeds.length > 0 && (
        <ul className="feeds-list">
          {feeds.map((feed) => (
            <li key={feed.id}>
              <h2>{feed.title}</h2>
              {feed.tags?.length > 0 && (
                <ul className="feed-tags" aria-label={`Tags for ${feed.title}`}>
                  {feed.tags.map((tag) => (
                    <li key={tag}>
                      <button
                        type="button"
                        onClick={() => handleTagToggle(tag)}
                        aria-pressed={tags.includes(tag.trim().toLowerCase())}
                        aria-label={`Filter by tag ${tag}`}
                      >
                        {tag}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
