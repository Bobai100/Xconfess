# Backend Integrations, API Deprecation, Topics, and Search Consistency

This document records the architectural design, security model, and API contracts for issues #382, #383, #386, and #387.

---

## 1. Signed Outbound Webhooks (#382)

### Overview
Provides an opt-in outbound webhook registry allowing user-authorized third-party integrations to receive real-time platform events (e.g. `confession.published`, `reaction.created`).

### Security & Signature Scheme
- **HMAC-SHA256 Signing**: Every delivery includes an `X-Webhook-Signature` header computed as:
  ```
  X-Webhook-Timestamp: <unix_seconds>
  X-Webhook-Id: <uuid>
  X-Webhook-Signature: t=<unix_seconds>,v1=HMAC_SHA256(timestamp + "." + raw_payload, secret)
  ```
- **Replay Protection**: Deliveries are stamped with a millisecond timestamp and unique event UUID (`X-Webhook-Id`). Consumers can verify timestamps within tolerance windows (e.g. 5 minutes).
- **Secret Rotation**: Secrets can be rotated on demand (`POST /webhooks/subscriptions/:id/rotate-secret`), updating the active HMAC key and logging `rotatedAt`. Secrets are masked in all query and list responses (`whsec_***`).
- **Bounded Retries**: Deliveries follow exponential backoff (1 min, 5 min, 15 min; capped at 3 attempts). A terminal failure status (`FAILED`) is assigned if maximum attempts are exceeded.

### Endpoints
- `POST /webhooks/subscriptions` - Register a new HTTPS webhook target and subscribed event types.
- `GET /webhooks/subscriptions` - List active subscriptions with masked credentials.
- `GET /webhooks/subscriptions/:id` - Fetch subscription details.
- `PATCH /webhooks/subscriptions/:id` - Update URL, event filter, or active status.
- `POST /webhooks/subscriptions/:id/rotate-secret` - Rotate HMAC secret.
- `DELETE /webhooks/subscriptions/:id` - Remove subscription and cascade deliveries.
- `GET /webhooks/subscriptions/:id/deliveries` - Query recent delivery status and audit history.
- `POST /webhooks/deliveries/:id/redeliver` - Manually trigger delivery retry.

---

## 2. API Deprecation Headers and Telemetry (#383)

### Overview
Standardizes endpoint lifecycle communication according to RFC 8594 (The Deprecation HTTP Header Field) and RFC 8288 (Web Linking), providing sunset metadata to client applications and measuring migration progress.

### Response Headers
When a route is marked with `@ApiDeprecated()`:
- `Deprecation: true`
- `Sunset: <HTTP-date>` (RFC 1123 format when sunset timestamp is configured)
- `Link: <alternativeRoute>; rel="successor-version"`, `<documentationUrl>; rel="deprecation"`

### Privacy-Preserving Telemetry
- **No Sensitive Data**: Telemetry records strictly omit request bodies, authorization credentials, cookies, and query parameter values.
- **Client Grouping**: User-Agent headers are normalized to coarse client categories (e.g., `chrome`, `firefox`, `python-requests`, `curl`) without fingerprinting individual users or IP addresses.
- **Aggregated Metrics**: Route hits and timestamps (`firstSeenAt`, `lastSeenAt`, `callCount`) are stored in `api_deprecation_metrics` and accessible to administrators via `GET /admin/telemetry/deprecated-endpoints`.

---

## 3. Validated Topic Assignment and Alias APIs (#386)

### Overview
Manages platform topic taxonomies with normalized uniqueness, alias resolution, moderator controls, and safe retirement semantics.

### Normalization & Uniqueness Rules
- Topic slugs and aliases are normalized to lowercase alphanumeric characters with single hyphens (`^[a-z0-9-]+$`).
- Uniqueness is validated across both canonical topic slugs and aliases to prevent routing ambiguities.

### Topic Lifecycle
- **Active**: Available for discovery, filtering, and assignment to confessions.
- **Retired**: Retained on existing confessions for historical integrity, but rejected if attempted to be newly assigned to new or updated confessions.
- **Merged**: Directs traffic and references to a target canonical topic. The merged topic's slug and all previous aliases automatically point to the target topic.

### Admin & Public Endpoints
- `POST /admin/topics` - Create canonical topic with initial aliases.
- `GET /admin/topics` - List all topics with status filters.
- `PATCH /admin/topics/:id` - Update topic metadata.
- `POST /admin/topics/:id/aliases` - Register alternative alias.
- `DELETE /admin/topics/:id/aliases/:alias` - Remove alias.
- `POST /admin/topics/:id/retire` - Retire topic safely.
- `POST /admin/topics/:id/merge` - Merge topic into another canonical topic.
- `GET /topics` - Public list of active topics.
- `GET /topics/resolve/:identifier` - Resolve any slug or alias to its canonical topic.

---

## 4. Transactionally Consistent Search Outbox (#387)

### Overview
Guarantees that changes to confession topic associations and confession deletions update authoritative PostgreSQL tables and search indexes atomically using a transactional outbox pattern.

### Operational Model
1. When confession topics are updated (`PUT /confessions/:id/topics`) or deleted (`DELETE /confessions/:id`), the change is executed inside a TypeORM transaction.
2. In the same database transaction, an outbox entry is written to `search_index_outbox` with action `TOPIC_SYNC` or `INDEX_DELETE`.
3. If the database transaction commits, the outbox record is guaranteed to exist.
4. `SearchIndexOutboxService` processes pending entries with bounded retries (up to 5 attempts with backoff: 30s, 2m, 10m, 30m, 1h) and provides on-demand reconciliation (`reconcileFailedEvents`).
