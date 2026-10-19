# Local Service Troubleshooting Decision Tree

Use this guide when local setup or the Docker-backed PostgreSQL and Redis
services fail. Commands below are run from the repository root. Keep diagnostic
output free of credentials and `.env` contents.

## 1. Can Docker respond?

```bash
docker info
docker compose -f compose.yaml ps
```

- If `docker info` cannot connect, start Docker Desktop or the Docker service,
  confirm Linux containers are enabled, then retry.
- If the Docker daemon is reachable but a service is absent, start only the
  infrastructure services:

  ```bash
  docker compose -f compose.yaml up -d postgres redis
  docker compose -f compose.yaml ps
  ```

- If a service is `starting` or `unhealthy`, continue to section 2. A running
  container is not necessarily ready to accept connections.

## 2. Which service is unhealthy?

Inspect only the service that is failing:

```bash
docker compose -f compose.yaml logs --tail=100 postgres
docker compose -f compose.yaml logs --tail=100 redis
```

For PostgreSQL, check its readiness and the configured host port:

```bash
docker compose -f compose.yaml exec postgres pg_isready -U postgres -d xconfess
```

The default host port is `55432` and the container port is `5432`. If the log
reports an existing data directory or an incompatible database state, preserve
the volume and ask the maintainer before attempting a reset.

For Redis, check the health response:

```bash
docker compose -f compose.yaml exec redis redis-cli ping
```

The expected response is `PONG`; the default host port is `6379`.

## 3. Is a host port already in use?

Check ports `55432` and `6379` before changing configuration.

On Linux or macOS:

```bash
lsof -nP -iTCP:55432 -sTCP:LISTEN
lsof -nP -iTCP:6379 -sTCP:LISTEN
```

On Windows PowerShell:

```powershell
Get-NetTCPConnection -LocalPort 55432,6379 -State Listen
```

Stop or reconfigure only the process you have identified. If you change a
Compose host port, update the matching local environment variable and keep the
container port unchanged.

## 4. Services are healthy, but the app cannot connect

- Confirm `DB_HOST` and `REDIS_HOST` are `localhost` when the app runs on the
  host, or `postgres` and `redis` when it runs in Compose.
- Confirm host-run PostgreSQL uses `DB_PORT=55432`; a backend container uses
  `DB_PORT=5432`. Redis uses `6379` in either case.
- Run `docker compose -f compose.yaml ps` again, then check the backend's
  `/api/health/ready` endpoint. Readiness identifies dependency failures more
  accurately than liveness.
- If environment changes do not take effect, restart only the affected app
  process or container after confirming the updated values are local-only.

## Safe cleanup and recovery

`docker compose -f compose.yaml down` stops and removes the Compose containers
and network while preserving named database and Redis volumes. It is a
reasonable recovery step after recording relevant logs.

Do **not** use `docker compose down --volumes`, `docker volume prune`, or remove
`xconfess-postgres-data` / `xconfess-redis-data` as routine troubleshooting.
Those actions permanently delete local database or Redis state. Use them only
when you intentionally want a full local data reset and have confirmed no data
needs to be kept.

For startup prerequisites and normal commands, see the
[Quick Start](../QUICK_START.md) and [Windows Setup](WINDOWS_SETUP.md).