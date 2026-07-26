# Coordination Server

The Coordination Server is AWSM's Rails application for authenticated synchronization and opaque
storage coordination. It must not receive or interpret plaintext Vault content.

## Development with Docker Compose

From the repository root, build and start Rails, PostgreSQL, and Redis for the first time:

```bash
docker compose up --build
```

For normal development after the image has been built:

```bash
docker compose up
```

Rails is available at <http://localhost:3000>. PostgreSQL and Redis are reachable only by services
on the Compose network and are not published to the host. Redis stores only short-lived Cable
ticket entries and Action Cable Pub/Sub messages; it is memory-bounded, non-persistent, and
deliberately disposable. The Rails source tree is bind-mounted into the container, and the
application runs in the standard `development` environment, so changes to application constants,
templates, and other watched files are reloaded without rebuilding the image or restarting the
server.

The Rails root renders the AWSM public-preview landing page on every deployment. `/privacy` and
`/security` provide factual trust-boundary explanations, `/glossary` defines product terms, and
`/design-system` is a rendered development/test fixture that is not routed in production. The four
public pages use a cache-safe layout and publish separate five-minute browser and 24-hour shared-CDN
freshness. They contain no Account state, CSRF token, or session cookie. Operators may place a
compatible CDN or reverse-proxy cache in front of those four exact paths; without one, Rails serves
them normally. All other routes remain dynamic and must be bypassed by shared caches.

A readable, random `awsm_browser_session_hint` functional cookie is set beside the authoritative
signed HttpOnly browser-session cookie after signup or sign-in. Only a browser carrying that hint
requests private, no-store `GET /session/status`; Stimulus then restores Account navigation and the
signed-in synchronization banner. The hint contains no credential or Account data and cannot
authenticate a request.

The landing, trust, installation, and Account pages use the repository-root `DESIGN.md` contract
and the bind-mounted `apps/design-system` package; they load the display font and visual assets
locally.

The server exposes Rails signup, Account management, strict `/api` Account and VaultDevice sessions,
and opaque synchronization endpoints. Account signup and password change happen on the Rails web
surface. Rails receives passwords over TLS and stores only password digests. The extension only
logs in; it never creates an Account. Recovery Phrases, recovery private material, Device secrets,
and unwrapped Vault keys must never reach Rails.

The server waits for PostgreSQL and runs `bin/rails db:prepare` each time it starts. PostgreSQL data
is retained in a named Docker volume across container restarts. Redis is started in dependency
order but Rails may boot while Redis is unavailable so authenticated HTTP polling remains usable in
degraded mode.

Production requires `AWSM_REDIS_URL` with a protected `redis://` or `rediss://` endpoint on private
infrastructure. `AWSM_REDIS_NAMESPACE` may override the validated environment namespace when
multiple logical Coordination Servers share a service. Never publish Redis directly, include it in
backups, or rely on its contents for synchronization correctness.

Run Rails commands in the application container with:

```bash
docker compose exec coordination-server bin/rails console
docker compose exec -e RAILS_ENV=test coordination-server bundle exec rspec
```

From the repository root, run the isolated operational resilience proof with:

```bash
CI=true corepack pnpm test:e2e:coordination
```

This Coordination Server E2E suite starts two Rails processes, stops its disposable Redis service, verifies
degraded readiness and authoritative HTTP polling, restarts Redis, and verifies that Cable-ticket
issuance and cross-process hint delivery recover. It uses its own Compose project, loopback ports,
temporary PostgreSQL storage, and disposable opaque-byte volume; its cleanup removes all of that
state. Its first scenario covers outage and recovery independently from packaged-extension browser
E2E and from the broader synchronization proof.

Stop the services while retaining development data:

```bash
docker compose down
```

To discard the local development database and other named-volume state, add `--volumes` to that
command. This is destructive. Because the repository remains pre-release and canonical migrations
are replaced in place, discard development volumes whenever the current schema changes; do not add
or rely on migrations from superseded drafts.

## When to rebuild

Rails source is bind-mounted into the running container. Do not rebuild for ordinary changes to
models, controllers, routes, views, Jobs, Services, JavaScript, CSS, tests, or other application
code. Rails development reloading makes those changes available directly.

Rebuild the `coordination-server` image when a change affects the image rather than the mounted
source tree:

| Change                                               | Action                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| `Gemfile` or `Gemfile.lock`                          | Rebuild so Bundler installs the changed gems                                   |
| `Dockerfile.development`                             | Rebuild so its changed instructions run                                        |
| `.ruby-version` or the Dockerfile's `RUBY_VERSION`   | Update both to match, then rebuild                                             |
| Native or operating-system libraries                 | Add or change the package in `Dockerfile.development`, then rebuild            |
| Application or shared design-system source and tests | No rebuild; restart Rails only if the specific configuration is not reloadable |
| Database migration                                   | No rebuild; run `bin/rails db:migrate` in the existing container               |
| `compose.yml` service configuration                  | Run `docker compose up`; Compose recreates affected containers as needed       |

Use this normal rebuild command:

```bash
docker compose up --build
```

Docker caches unchanged build steps. If `Gemfile` and `Gemfile.lock` have not changed, the cached
`bundle install` layer is reused. To refresh the matching Ruby base image as part of a rebuild:

```bash
docker compose build --pull coordination-server
docker compose up
```

Use a cache-free rebuild only when the image cache is demonstrably stale or corrupt, because it
reinstalls all operating-system packages and gems:

```bash
docker compose build --no-cache coordination-server
docker compose up
```

## Development troubleshooting

Inspect service state and recent logs first:

```bash
docker compose ps
docker compose logs --tail=100 coordination-server postgres redis
```

Validate the resolved Compose configuration:

```bash
docker compose config --quiet
```

If Rails code is not reloading, confirm the service is running in `development`, then restart it
without rebuilding:

```bash
docker compose exec coordination-server bin/rails runner 'puts Rails.env'
docker compose restart coordination-server redis
```

After adding or updating a gem, rebuild instead of running `bundle install` only in the existing
container. Container-local changes disappear when that container is recreated.

Run migrations and tests without rebuilding:

```bash
docker compose exec coordination-server bin/rails db:migrate
docker compose exec coordination-server bundle exec rspec
```
