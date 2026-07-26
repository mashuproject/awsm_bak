# CDN-Cached Public Rails Pages TDD Evidence

**Document:** `docs/plans/17-cdn-cached-public-rails-pages-tdd-evidence.md`

**Status:** In progress

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

Not performed. Repository implementation does not authorize remote deployment, DNS, CDN, cache
rule, purge, or production changes.
