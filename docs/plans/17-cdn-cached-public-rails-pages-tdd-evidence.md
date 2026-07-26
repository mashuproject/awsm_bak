# CDN-Cached Public Rails Pages TDD Evidence

**Document:** `docs/plans/17-cdn-cached-public-rails-pages-tdd-evidence.md`

**Status:** Complete

**Owner:** Engineering

**Last Updated:** 2026-07-26

**Implements:** `docs/plans/17-cdn-cached-public-rails-pages.md`

---

# 1. Scope

This ledger records contemporaneous implementation and verification evidence for Plan 17. It
contains no credentials, cookies, user data, Cloudflare identifiers, private topology, or retained
remote configuration.

# 2. Request-contract TDD

## RED

Plan 17 request examples were added before implementation for:

- the four public-page cache headers and cache-safe shared representation;
- configured-origin rendering and registration state;
- dynamic-route cache bypass;
- private session-status response shapes and CSRF-protected sign-out; and
- browser-session hint creation, rotation, and deletion.

Command:

```bash
docker compose exec -e RAILS_ENV=test coordination-server \
  bundle exec rspec spec/requests/plan17_public_page_caching_spec.rb
```

Observed: 9 examples, 8 failures. The failures confirmed the absent public cache headers,
session-dependent public HTML, request-Host rendering, missing `/session/status` route, absent
session hint, and incomplete cookie cleanup. The remaining example proved dynamic routes did not
already receive the proposed public cache policy.

## GREEN

The focused request suite passed all 11 examples after implementation. It verifies public cache
policy isolation, byte-equivalent Account-independent HTML, configured-origin rendering, exact
private status shapes, `GET`/`HEAD` and query invariance, CSRF-protected sign-out, forged-cookie
failure, random hint rotation, production Secure attributes, and cookie cleanup. Rails canonically
serializes the semantically unordered browser directives as `max-age=300, public`; the test
compares the exact directive set rather than textual order.

# 3. Browser and rendered TDD

## RED

Pending.

## GREEN

The Rails design lane now covers:

- zero status requests for anonymous public visits;
- a complete JavaScript-disabled public page;
- authenticated status restoration, exact-hint reuse across Turbo visits, and new-hint lookup;
- Account navigation, signed-in banner actions, and CSRF-protected sign-out;
- stale hints plus server-error and malformed-status failure;
- a non-personal loading shell; and
- desktop and narrow authenticated layouts.

The full rendered design lane passed 7 examples after the final interaction fix. Updated privacy,
security, authenticated narrow-menu, loading-shell, and failure-fallback screenshots were viewed
manually for contrast, overlap, clipping, overflow, and exposed private state.

# 4. Documentation Reconciliation

Reconciled the repository README, Coordination Server README, deployment/operations architecture,
testing strategy, Plan 16, and the rendered privacy/security pages. The Roadmap contained no
public-page caching candidate to remove or narrow.

# 5. Final Verification

The production Coordination Server image built successfully as `awsm-coordination-plan17`.
It was started only against disposable local PostgreSQL and Redis containers with non-secret test
configuration. All four public URLs returned successful fingerprinted HTML with the browser/CDN
cache directive sets and no `Set-Cookie`; `/session/status` returned `private, no-store`; and
`/sign_up` remained private and dynamic. The disposable containers and network were removed after
inspection.

Repository verification:

- RSpec: 97 examples, 0 failures;
- RuboCop: 139 files, no offenses;
- design contract: 0 errors and 0 warnings;
- rendered design E2E: 7 examples passed; and
- production image build and isolated header inspection: passed.

# 6. Reference Staging Rollout

The user separately authorized the reference staging deployment and then explicitly authorized a
hostname-specific staging route on the existing one-service-per-host Cloudflare Tunnel. The
production application, mutable state, hostname rule, and connector process remained in place.

The reference host was re-inspected before mutation. The production application uses Docker
Compose while one host-managed, remotely configured `cloudflared` service supplies ingress. In
accordance with current Cloudflare guidance, staging reuses that connector rather than installing a
second service on the same machine.

The isolated staging deployment now has:

- a distinct Compose project and deployment root;
- a loopback-only origin listener;
- independently generated environment secrets;
- separate PostgreSQL data, Redis, opaque storage, logs, and runtime state; and
- `https://awsm.parasquid.dev` as its configured public origin.

The deployed origin passed pre-tunnel checks for all four public pages: HTTP `200`, current public
content, exact browser and CDN cache directives, and no `Set-Cookie`. `/session/status` returned
HTTP `200` with `Cache-Control: private, no-store`.

The remotely managed tunnel update was dry-run first. The applied configuration added exactly one
staging hostname rule before the existing fail-closed catch-all. A before/after comparison proved
the production hostname rule was unchanged, and the shared connector did not restart. A single
proxied staging CNAME was then created after a successful dry run. Public DNS resolves, HTTPS
returns `200` through Cloudflare, and the public response emits no cookie.

The CLI-managed OAuth profile could read the zone, DNS, and tunnel configuration and could update
tunnel ingress and staging DNS, but lacked Cache Rules and Zone Settings permissions. The operator
supplied a separately created, ignored, mode-`0600`, staging-zone token with Cache Rules Edit, Zone
Settings Write, Cache Purge, and Zone Read. Its value was never printed, copied to the server,
loaded into Rails, or retained in this evidence.

The zone initially had no `http_request_cache_settings` entry-point ruleset. A dry-run validated a
new zone entry point containing exactly one enabled rule named `AWSM staging public Rails pages`.
The rule matches only `GET` and `HEAD` requests for the staging hostname and the four canonical
public paths. It makes those responses cache-eligible, uses `bypass_by_default` Edge TTL,
respects origin browser TTL, preserves origin cache control and error behavior, and allows stale
revalidation.

The reference zone rejected the planned query-string exclusion as “not entitled to use the custom
cache key override.” The user selected Cloudflare's default query-sensitive cache key for staging.
The four actions remain query-invariant and safe, but distinct query strings may create separate
cache entries and origin misses. No broader cache expression or alternate proxy was introduced.

Smart Tiered Cache was inspected as `off` and left unchanged because it is a shared zone-wide
setting. The four-URL purge was dry-run and then applied without purging the zone or immutable
assets. The first canonical requests returned `MISS`; subsequent requests returned `HIT` with
positive `Age` for all four paths. `/session/status`, `/sign_up`, `/account`,
`/api/server-information`, and `/ready` remained `DYNAMIC`. Final public checks confirmed HTTP
`200`, `HIT`, positive `Age`, and no `Set-Cookie` on every cacheable path.

The production Compose project retained both declared services running, the shared connector
remained active without restart, and its production hostname rule remained unchanged. The
staging Compose project retained all three isolated services running.

# 7. Anchor Offset Follow-up

The first staging visual inspection reproduced the `#how-it-works` eyebrow clipped beneath the
sticky header divider at both desktop and 390px narrow widths. A scoped `scroll-margin-top` rule
for anchored story sections and a rendered geometry assertion were added. The full seven-example
design lane passed, the staging image was rebuilt without touching production, and before/after
screenshots confirmed the eyebrow and heading clear the sticky divider at both widths.
