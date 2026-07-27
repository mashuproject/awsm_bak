# CDN-Cached Public Rails Pages

**Document:** `docs/plans/17-cdn-cached-public-rails-pages.md`

**Status:** Implemented; Account identity payload reconciled by Plan 20

**Owner:** Engineering

**Last Updated:** 2026-07-27

**Depends On:** `AGENTS.md`, `DESIGN.md`, `README.md`, `ROADMAP.md`,
`docs/plans/16-product-design-system-landing-and-surface-redesign.md`,
`docs/architecture/03-zero-knowledge.md`, `docs/architecture/15-coordination-server.md`,
`docs/architecture/19-testing-strategy.md`,
`docs/architecture/20-deployment-and-operations.md`, and
`apps/coordination-server/README.md`

> **Current-contract notice:** Plan 20 replaces the private session-status Account field and
> personalized landing-page label in this plan with `username`. The cache boundary and anonymous
> shared-representation contract remain current. See
> [Plan 20](20-username-account-and-devices-dashboard.md).

---

# 1. Purpose

This is the decision-complete implementation plan for serving the Rails-rendered AWSM public
product pages efficiently through a shared CDN cache without maintaining static HTML files and
without involving Rails on anonymous cache hits. The application contract is portable across
hosted and self-hosted deployments. Cloudflare is the CDN adapter used by the AWSM reference
service, not an architectural requirement for every operator.

It is written for an implementer starting from a cold checkout with no conversation context. Do
not reopen the fixed cache-layer, page-rendering, personalization, route, cookie, or TTL decisions
recorded here.

The completed work SHALL:

1. keep ERB as the authored and origin-rendered source for the public pages;
2. make `/`, `/privacy`, `/security`, and `/glossary` safe to store as one shared representation
   per deployment;
3. define a general staging-before-production rollout contract;
4. deploy and validate the AWSM reference service first at `https://awsm.parasquid.dev`;
5. let a configured CDN serve anonymous requests without contacting Rails on cache hits;
6. preserve the signed-in landing treatment through a private client-side session-status
   enhancement;
7. make anonymous public-page visits perform no Account-status request and no Rails session lookup;
8. keep signup, sign-in, Account management, synchronization, ticket handling, API, Action Cable,
   liveness, and readiness requests dynamic;
9. retain the existing one-year immutable production caching of fingerprinted assets;
10. make cache freshness, invalidation, failure behavior, and rollout verification explicit; and
11. preserve the zero-knowledge and no-tracking boundaries.

This plan changes delivery and public-page personalization. It does not change the authoritative
Account model, API authentication, Vault synchronization protocol, ticket semantics, or encrypted
storage boundary.

# 2. Fixed Decisions, Scope, and Deferrals

## 2.0 Environment model and reference deployment

Every operator applying this plan SHALL use two logical environments:

| Environment | Purpose                                                       |
| ----------- | ------------------------------------------------------------- |
| staging     | isolated validation of code, cache policy, routing, and purge |
| production  | stable user-facing service promoted only after staging passes |

An operator may place the environments on separate hosts or colocate them. Colocation does not
permit shared mutable state. Each environment requires:

- an origin and host route unique to that environment;
- a separately named application process or container;
- separate environment configuration;
- a separate PostgreSQL database and credentials;
- a separate Redis connection/namespace;
- separate queue state and workers;
- separate opaque storage;
- separate logs, runtime state, health checks, and cache entries; and
- an environment-specific `AWSM_PUBLIC_ORIGIN`.

Never connect staging to production databases, Redis namespaces, queues, storage, credentials,
writable application directories, or user data. Staging requests must not select the production
process, and production requests must not select staging.

The AWSM reference deployment assigns:

| Environment | Public origin                | Cloudflare zone |
| ----------- | ---------------------------- | --------------- |
| staging     | `https://awsm.parasquid.dev` | `parasquid.dev` |
| production  | `https://awsm.foo`           | `awsm.foo`      |

The reference staging and production processes may run on the same physical server, but retain all
of the isolation above. The reference host uses one remotely managed Cloudflare Tunnel connector
for the machine, with separate exact-hostname ingress rules selecting the isolated staging and
production origins. Sharing the connector and tunnel transport does not permit shared application
processes or mutable state. No host-local path, address, credential, opaque resource identifier,
container name, or private topology belongs in tracked project documentation.

Plan 17 implements and validates staging. Production promotion is a later, separately authorized
operation after all staging gates pass. A staging rollout never implies permission to change
production.

These reference names are deployment examples, not application defaults. Do not hardcode
`awsm.parasquid.dev`, `awsm.foo`, `parasquid.dev`, Cloudflare account details, or reference-server
topology into Rails, JavaScript, container images, tests, example environment files, or reusable
deployment code. Self-hosted installations supply their own origins and CDN configuration. Use
reserved example domains such as `example.test` in automated tests.

## 2.1 Fixed architecture

The request path for each environment is:

```text
Browser
  |
  v
configured shared CDN cache
  |-- cache hit for a public page ------------> response to browser
  |
  `-- cache miss or any dynamic route
        |
        v
      environment-specific origin route
        |
        v
      environment-specific Thruster / Rails
```

The AWSM reference origin route is a hostname-specific rule on one remotely managed Cloudflare
Tunnel connector. Cloudflare permits one tunnel to proxy multiple services and recommends only one
service-managed `cloudflared` instance per host. The staging rule maps only
`awsm.parasquid.dev` to the isolated staging listener; the existing `awsm.foo` rule and production
listener remain unchanged. Self-hosted operators may use an equivalent isolated routing layer.

The only new shared page-cache layer is the configured CDN. The AWSM reference deployment uses
Cloudflare. Self-hosted operators may use another compatible CDN or reverse-proxy cache that honors
the application headers and route allowlist. Running without a CDN remains supported: Rails then
serves every request normally, with no Cloudflare SDK, gem, CLI, or network dependency in the
application runtime.

- Do not add Caddy, Varnish, Vinyl Cache, NGINX, or a custom proxy build to the repository or AWSM
  reference deployment.
- Do not add a Rails fragment, action, Solid Cache, Rack, or process-local full-page cache as a
  substitute for the shared edge cache.
- Do not pre-render or maintain `.html` page files.
- Do not move the product pages into a separate static-site framework or service.
- Do not add a service worker for this server-rendered website.

The CDN caches the HTTP response produced by the existing Rails ERB views. An edge miss may still
invoke Rails. An edge hit must not.

## 2.2 Cacheable routes

Only successful `GET` and `HEAD` responses for these exact paths are public-page cache candidates:

| Path        | Rails action              |
| ----------- | ------------------------- |
| `/`         | `HomeController#show`     |
| `/privacy`  | `HomeController#privacy`  |
| `/security` | `HomeController#security` |
| `/glossary` | `HomeController#glossary` |

The application contract proves that none of these four actions varies by query parameter. The
reference staging zone is not entitled to custom cache-key overrides, so it uses Cloudflare's
default query-sensitive cache key. Canonical URLs share normally, while distinct query strings may
create separate safe cache entries and origin misses. Operators with an entitled custom-key feature
may ignore the entire query string for these four exact actions after preserving scheme and host.

The development/test-only `/design-system` action is not cacheable and is not routed in production.

## 2.3 Dynamic routes

Every route outside the four exact public paths remains dynamic. In particular, never apply the
public-page CDN rule or public cache headers to:

- `/sign_up`;
- `/session`, `/session/new`, and the session-status route introduced by this plan;
- `/account` and `/account/password`;
- `/api/*`;
- `/cable`;
- `/up` and `/ready`;
- transfer-ticket URLs or opaque-byte transfers;
- errors, redirects, or unknown routes; and
- non-`GET`/`HEAD` requests.

The CDN rule must be an allowlist for the four exact paths. Do not express it as a broad
extension, directory, prefix, or “cache everything on this host” rule.

## 2.4 Shared versus private state

The cacheable page representation may include state that is identical for the deployment:

- `Coordination::Registration.public_origin`;
- the current registration-enabled configuration;
- the existing public product copy and installation state compiled into the deployed revision;
- links derived from fixed routes and public documentation constants; and
- fingerprinted asset URLs.

It must not include:

- a current Account;
- an Account username or other user metadata;
- whether the request carried a valid browser session;
- a CSRF token;
- a flash message;
- a sign-out form;
- a session-specific CSP nonce;
- a session identifier or session hint;
- an `Authorization` value;
- a personalized cache key; or
- a `Set-Cookie` response header.

The deployment origin and registration setting remain rendered by Rails into the shared page.
Changing either setting requires invalidating the four public URLs as specified in section 7.

## 2.5 Signed-in enhancement

The existing signed-in landing experience remains a progressive client-side enhancement:

- anonymous/no-JavaScript markup is the shared cacheable baseline;
- a non-secret client-readable hint says only that a valid browser session may exist;
- only a browser carrying that hint calls the private session-status route;
- Rails validates the existing signed HttpOnly `browser_session_id` cookie;
- the private response supplies the current Account display state and a CSRF token;
- Stimulus renders the signed-in header, footer, banner, Account actions, and sign-out form; and
- failure or invalid authentication leaves the safe anonymous baseline visible.

The hint is never authentication, authorization, or trusted state. Modifying or forging it may at
most cause one private status request.

## 2.6 Browser and edge freshness

Use these exact successful public-page response headers:

```http
Cache-Control: public, max-age=300
CDN-Cache-Control: public, max-age=86400, stale-while-revalidate=86400, stale-if-error=604800
```

Header directive sets and values are exact. HTTP directive order is not significant; Rails may
serialize the browser header as `max-age=300, public`.

The resulting policy is:

- browsers may reuse a public page for five minutes;
- the configured CDN may treat it as fresh for 24 hours;
- the configured CDN may serve it stale for up to 24 hours while asynchronously revalidating;
- the configured CDN may serve the prior representation for up to seven days when origin revalidation
  fails with an eligible server error; and
- an explicit purge after a relevant deployment or configuration change supplies immediate
  freshness rather than waiting for TTL expiry.

Do not add `s-maxage`: it conflicts with the required Cloudflare stale-revalidation behavior in the
reference deployment. Use the provider-neutral `CDN-Cache-Control` header to separate browser and
shared CDN policies without making the Rails response specific to one provider.

## 2.7 Explicitly deferred

- changing zone-wide Smart Tiered Cache state on the shared `parasquid.dev` zone;
- an additional origin-shield service;
- Cache Reserve;
- Cloudflare Workers;
- Cloudflare Cache API code;
- HTML fragment streaming;
- Edge Side Includes;
- server-rendered per-Account cache variants;
- caching the Account-status response;
- Account state pushed over Action Cable to the landing page;
- offline availability of the product site;
- public-page analytics, cache analytics ingestion, or user tracking;
- a general infrastructure-as-code migration for all Cloudflare settings; and
- production promotion as part of the initial staging implementation.

Repository implementation, staging rollout, and production promotion are separate stages. None
implicitly authorizes the next. External deployment changes always require explicit authorization.

## 2.8 Licensing

This plan adds no runtime or development dependency. Use Rails, Turbo, Stimulus, Propshaft,
Thruster, and browser APIs already present in the repository.

Do not copy or adapt third-party cache middleware or client-side session code. If implementation
discovers a need for an additional dependency, stop and obtain approval after documenting its
exact version, source, license, and commercial-relicensing consequences.

# 3. Canonical HTTP Contracts

## 3.1 Public-page response contract

Add one private `set_public_page_cache_policy` method to `HomeController` and invoke it with an
`after_action` limited to `show`, `privacy`, `security`, and `glossary`. Do not create a generic
concern and do not set public caching globally on `ApplicationController`.

Each successful public-page response SHALL:

- have status `200`;
- have `Content-Type: text/html`;
- emit the two exact cache headers from section 2.6;
- emit no `Set-Cookie`;
- contain no CSRF metadata;
- contain the canonical public origin;
- contain the configured registration state;
- contain anonymous fallback navigation;
- omit every Account username and personalized action; and
- use fingerprinted production asset URLs.

Rails/Rack may continue to provide `ETag` or `Last-Modified` validators. Do not remove a validator
that Rails already emits. Do not invent a database-backed cache version or timestamp solely to
create one.

Only set the cache headers on a successful render. A raised routing error, exception response,
redirect, or non-success result must not inherit this policy.

## 3.2 Public layout contract

Add a dedicated public layout and use it for the cacheable `HomeController` actions. It SHALL
preserve the existing document title, viewport metadata, icons, local stylesheet, import map, and
page body classes.

It SHALL NOT render:

- `csrf_meta_tags`;
- Rails flash state;
- user-specific metadata;
- a session-dependent content-security-policy nonce; or
- any form whose submission requires a CSRF token.

Do not weaken CSRF handling in the existing application layout. Signup, session, Account, password,
and design-system pages continue to use a layout that includes CSRF metadata and flashes.

Extract the common safe head markup to `app/views/layouts/_head.html.erb` and render it from both
layouts. Keep `csrf_meta_tags` and flash rendering only in the existing application layout. The
partial must preserve current output and asset tracking. Do not use this work as an opportunity to
restyle unrelated pages.

## 3.3 Session-status route

Add this browser-only route:

```text
GET /session/status
```

Route it to `SessionsController#show`. It is not part of `/api`, does not use the coordination
protocol headers, and must not be added to the OpenAPI specification.

Every response uses:

```http
Cache-Control: private, no-store
Content-Type: application/json
```

The authenticated response is status `200` with exactly:

```json
{
  "authenticated": true,
  "account": {
    "username": "reader"
  },
  "csrfToken": "rails-generated-token"
}
```

The unauthenticated response is status `200` with exactly:

```json
{
  "authenticated": false
}
```

Do not return Account IDs, BrowserSession IDs, timestamps, IP addresses, user agents, Vault state,
API credentials, Device state, synchronization state, or any other Account fields.

The action is allowed without authentication so it can return the unauthenticated representation.
It validates the signed HttpOnly session cookie through the existing `resume_session` path. It must
not create a Rails session, redirect to `/session/new`, or record a return URL.

The CSRF value comes from Rails' request-forgery protection API and is returned only when the
browser session is valid. JavaScript uses it only to submit the existing `DELETE /session`
operation. Do not make sign-out a `GET`, disable CSRF checks, or introduce an alternate logout
route.

## 3.4 Session-hint cookie

Use this exact cookie name:

```text
awsm_browser_session_hint
```

On each successful browser signup or sign-in, write a newly generated URL-safe random value with at
least 128 bits of entropy. The value is an opaque change detector; it is not stored in the database,
signed, encrypted, logged, or compared by Rails.

Use these cookie properties:

| Property  | Value                                                   |
| --------- | ------------------------------------------------------- |
| path      | `/`                                                     |
| same-site | `Lax`                                                   |
| secure    | true in production and false in development/test        |
| HttpOnly  | false                                                   |
| lifetime  | permanent, matching the browser-session cookie behavior |

Keep the existing signed `browser_session_id` cookie HttpOnly and authoritative.

Delete the hint with the same path and secure behavior when:

- `SessionsController#destroy` terminates the current browser session;
- a password change revokes all sessions and clears the current browser cookie; or
- `GET /session/status` finds that the hint is present but the authoritative session is absent or
  invalid.

Centralize setting and deletion beside the existing `start_new_session_for` and
`terminate_session` behavior so signup and sign-in cannot drift. Reuse the same deletion helper
from password change.

Do not log the hint value. Add it to parameter/cookie filtering only if the chosen Rails logging
configuration could otherwise retain it.

## 3.5 Client rendering contract

Add a Stimulus controller named `public_session_controller.js` and attach it only to the four
cacheable public pages.

The shared HTML is fully usable before this controller runs:

- header and footer show `Sign in`;
- the signed-in banner is not presented to assistive technology;
- registration guidance uses the shared deployment state;
- all content, installation instructions, trust explanations, and navigation work without
  JavaScript.

The HTML provides inert targets for:

- header Account/sign-in link;
- footer Account/sign-in link;
- signed-in banner container;
- signed-in username text;
- Account link;
- setup-sync link; and
- sign-out form container.

Do not place a username, CSRF token, or hidden personalized HTML in the cacheable markup.

On connect, the controller SHALL:

1. parse `document.cookie` by cookie name, without substring matching;
2. do nothing if `awsm_browser_session_hint` is absent;
3. if the hint exists, reveal a fixed/minimum-height loading shell for the signed-in banner with
   `aria-busy="true"` so the final content does not unexpectedly move the surrounding page;
4. request `/session/status` with same-origin credentials and an `Accept: application/json`
   header;
5. require a successful HTTP response and the exact expected JSON shape;
6. populate user text with `textContent`, never `innerHTML`;
7. create the sign-out form with DOM APIs, method `post`, action `/session`, a hidden
   `_method=delete`, and the returned hidden `authenticity_token`;
8. change header and footer navigation from `Sign in` to `Account`;
9. remove `aria-busy`, reveal the populated signed-in banner, and preserve the existing visible
   Account, setup-sync, and sign-out actions; and
10. leave or restore the anonymous baseline on an unauthenticated response, malformed response,
    network failure, or abort.

Module-level state may reuse one in-flight/completed status request across Turbo visits, but it
must be keyed by the exact hint value:

- the same hint reuses the same result during the current document lifetime;
- a new login writes a new hint and therefore forces a new request;
- clearing the hint prevents reuse after logout; and
- failures are not retained indefinitely: a later full connection may retry.

Do not store the username or CSRF token in `localStorage`, `sessionStorage`, IndexedDB, the URL, or
diagnostics. Module memory for the current document is sufficient.

Disconnect must abort target-specific DOM work safely. A response from an older controller
instance must not mutate a new Turbo page whose targets are no longer connected.

## 3.6 Registration and deployment copy

Keep registration state server-rendered because it is shared across the deployment. The cached
response may continue to:

- say that Account creation is open and link to `/sign_up`; or
- say that Account creation is closed and omit the signup link.

Changing `AWSM_ACCOUNT_REGISTRATION_ENABLED` requires a public-page purge after the changed process
is serving traffic.

Use `Coordination::Registration.public_origin` as the canonical rendered deployment origin instead
of deriving it from an arbitrary request Host. The CDN still keys by the requested hostname, but
the product strip must show the validated configured public origin. This prevents an
untrusted/spoofed Host representation from being stored and replayed.

# 4. Code Ownership and File Map

The implementer should expect to change these areas:

| Area                         | Primary location                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| routes                       | `apps/coordination-server/config/routes.rb`                                                  |
| public response policy       | `apps/coordination-server/app/controllers/home_controller.rb`                                |
| session status and lifecycle | `apps/coordination-server/app/controllers/sessions_controller.rb` and authentication concern |
| password revocation          | `apps/coordination-server/app/controllers/account_passwords_controller.rb`                   |
| cache-safe layout            | `apps/coordination-server/app/views/layouts/`                                                |
| public personalization hooks | public header, footer, and landing views                                                     |
| browser enhancement          | `apps/coordination-server/app/javascript/controllers/`                                       |
| request coverage             | Plan 15 authentication and Plan 16 product-site request specs                                |
| rendered coverage            | `apps/browser-extension/tests/design/rails.design.e2e.test.ts`                               |

Do not create a parallel Account service or a second authentication concern. Do not modify the
extension's API session model; this hint applies only to Rails browser authentication.

# 5. TDD Implementation Sequence

Create
`docs/plans/17-cdn-cached-public-rails-pages-tdd-evidence.md` when implementation begins.
Record contemporaneous RED, GREEN, refactoring, command, and rendered-inspection evidence. Do not
invent historical RED output.

## Task 1 — Lock the cache-safe public response

### RED

Add request examples proving:

- all four public routes return the exact browser and CDN cache-control policies;
- an anonymous request emits no `Set-Cookie`;
- public output contains no CSRF meta tag or authenticity token;
- a valid signed-in browser request receives the same shared HTML representation as an anonymous
  request;
- the shared representation contains no Account username, signed-in banner, sign-out form, or
  Account-specific accessible label;
- public output still contains origin, registration state, content, navigation, and fingerprinted
  assets;
- registration-open and registration-closed shared representations remain correct;
- `/design-system` does not receive the public caching policy;
- dynamic Account/session/signup routes do not receive it; and
- a missing/failed route does not receive it.

Compare normalized full response bodies where Rails-generated nondeterminism exists. The preferred
outcome is byte-equivalent public bodies for anonymous and authenticated requests after the
cache-safe layout removes all session data.

### GREEN

- Add the public layout.
- Stop resolving `@current_account` in `HomeController`.
- Use the validated configured public origin.
- Apply the exact cache policy only to successful public actions.
- Render anonymous navigation and inert enhancement targets.
- Preserve registration-aware shared copy.

### Refactor

Keep the extracted head partial free of request or session state. Keep cache behavior obvious at
the `HomeController` boundary; do not bury it in generic middleware.

## Task 2 — Add the private Account-status contract

### RED

Add request examples proving:

- `GET /session/status` is routable without protocol headers;
- no valid browser session returns only `{"authenticated":false}`;
- a valid browser session returns only the authenticated schema from section 3.3;
- the action never redirects;
- both states use `private, no-store`;
- neither state receives a public CDN cache header;
- forged/invalid browser cookies return the unauthenticated shape;
- the response never exposes Account ID, BrowserSession ID, Vault, Device, or synchronization
  fields; and
- the authenticated CSRF token can submit the existing sign-out operation successfully.

### GREEN

Implement `SessionsController#show` by reusing the existing browser-session lookup and calling
`render json:` directly. Do not add a presenter or Jbuilder template for this two-shape contract.

### Refactor

Keep the status payload construction narrow and auditable. It is presentation state, not an
architectural Account API.

## Task 3 — Add the non-authoritative hint lifecycle

### RED

Add request examples proving:

- signup sets both the signed HttpOnly browser-session cookie and the readable hint;
- sign-in does the same;
- consecutive successful logins produce different hint values;
- the hint has the required path, SameSite, Secure-by-environment, persistence, and non-HttpOnly
  attributes;
- logout deletes both cookies;
- password change deletes both cookies after revoking all sessions;
- an invalid authoritative session plus a hint causes status to return unauthenticated and expire
  the hint;
- forging only the hint never authenticates the request; and
- no response body or retained test log exposes the hint.

### GREEN

Centralize hint creation/deletion in the browser authentication concern. Generate the value with
Ruby's existing secure random facility. Ensure cookie deletion options match cookie creation.

### Refactor

Use one helper for current-session termination and one helper for browser-cookie cleanup. Do not
duplicate cookie option hashes across controllers if doing so could cause deletion drift.

## Task 4 — Reconstruct signed-in UI with Stimulus

### RED

Extend the Rails design E2E lane to prove:

- anonymous public loading issues no `/session/status` request;
- the anonymous page is complete with JavaScript disabled;
- after signup/sign-in, visiting `/` requests status and displays the current username;
- header and footer links change to `Account`;
- the signed-in banner exposes `Account`, `Set up sync`, and `Sign out`;
- sign-out uses the returned CSRF token and succeeds;
- logout restores anonymous navigation and does not reuse cached module state;
- a stale hint plus an unauthenticated status response restores anonymous UI and clears the hint;
- a status `500`, malformed JSON, and an aborted navigation fail closed to anonymous UI without an
  unhandled browser error;
- navigating among public pages under Turbo reuses a single status lookup for one hint;
- a newly issued hint forces a new lookup; and
- loading and authenticated layouts have no unintended clipping, overlap, overflow, or avoidable
  layout movement.

### GREEN

Implement the controller and cache-safe targets exactly as section 3.5 defines. Preserve the
current signed-in banner language unless factual changes are needed to explain that Account login
does not unlock a Vault.

### Refactor

Keep cookie parsing, payload validation, request memoization, and DOM rendering as small named
functions. Avoid a general client-side state framework.

## Task 5 — Documentation and operational policy

Update all current documents that describe:

- server-rendered authenticated public states;
- the public product surface;
- functional browser cookies;
- deployment caching;
- production request handling;
- testing expectations; and
- future deployment work.

At minimum audit:

- `README.md`;
- `apps/coordination-server/README.md`;
- `docs/architecture/20-deployment-and-operations.md`;
- `docs/architecture/19-testing-strategy.md`;
- the relevant Plan 16 product-surface decisions and assertions;
- `ROADMAP.md`; and
- public `/privacy` and `/security` copy.

Plan 16 remains authoritative for visual/product design. Reconcile statements that say
authentication is server-rendered into the landing response so they instead describe the
cache-safe shared baseline and private client enhancement.

The privacy page must identify `awsm_browser_session_hint` as a first-party functional cookie that
contains no credential or Account data and exists only to avoid anonymous Account-status requests.
Do not describe it as analytics, tracking, or authentication.

Audit `ROADMAP.md` under the repository completion policy. Remove or narrow only work completed by
this plan; do not mark completed entries as done.

# 6. AWSM Reference Cloudflare Adapter

Sections 1–5 define the portable open-source application contract. This section applies that
contract to AWSM's reference staging service. Self-hosted operators SHALL translate the same exact
host/path allowlist, TTLs, error bypass, purge ordering, and privacy constraints into their chosen
CDN without copying AWSM-specific domains or Cloudflare credentials/configuration.

## 6.1 Required Cloudflare CLI

Use Cloudflare's official unified `cf` CLI. For this plan, the exact verified invocation is:

```bash
npx --yes cf@0.5.0
```

Do not use the unrelated Cloud Foundry `cf`, the third-party `cloudflare-cli`/`cfcli`, Wrangler,
Cloudflare dashboard edits, Terraform, or hand-written raw API requests for the reference staging
rollout. This restriction governs AWSM's reference operations, not the tools a self-hosted operator
may use for a different provider or an independently managed Cloudflare deployment. The unified CLI
exposes the required zone Rulesets, cache purge, and Smart Tiered Cache operations.

The CLI is a technical preview. Some generated products do not appear in its top-level `--help`
output even though their commands are available. Before acting, inspect the installed command
surface without authentication:

```bash
npx --yes cf@0.5.0 schema --list
npx --yes cf@0.5.0 rulesets --help
npx --yes cf@0.5.0 cache --help
```

For each concrete command, inspect its command-specific `--help` and schema immediately before use.
If version `0.5.0` no longer matches the current Cloudflare API, stop and amend this plan to pin and
review a newer exact version. Do not silently switch to `latest`.

For interactive authorized work, authenticate through a CLI-managed OAuth profile. For unattended
automation, use a narrowly scoped `CLOUDFLARE_API_TOKEN` supplied only by the deployment secret
system. Use `--zone parasquid.dev` so the CLI resolves the staging zone without copying its opaque
identifier into commands or documentation.

Cloudflare CLI JSON may contain confidential operational metadata. Do not print, paste into chat,
commit, or retain authentication material, account/zone/ruleset identifiers, profile bindings,
full rulesets, DNS inventories, or unrelated configuration. Filter inspection results to the
minimum non-sensitive fields needed for the current decision.

Every mutation requires separate explicit staging-change authorization. Run the same command with
`--dry-run` first whenever the command supports it. A successful dry run is not authorization to
perform the mutation.

## 6.2 Preconditions

Before creating or enabling the reference staging rule, verify read-only:

- `parasquid.dev` is active in the authenticated Cloudflare account;
- the intended `awsm.parasquid.dev` DNS record is proxied through Cloudflare;
- no staging command targets the production `awsm.foo` zone, hostname, cache, DNS, application
  process, or mutable state;
- the shared tunnel's existing production ingress rule is captured only as an in-memory
  comparison and remains byte-equivalent after the staging rule is added;
- all four deployed paths return `200`;
- responses contain the expected current product content;
- the origin revision contains this plan's cache-safe implementation;
- each response has the two exact cache headers;
- no response has `Set-Cookie`;
- `/session/status` returns `private, no-store`;
- the current Cloudflare ruleset has no later rule that would override this rule; and
- the current deployment topology and host routing have been re-inspected.

Treat Cloudflare state as mutable and confirm the staging zone through a filtered read-only CLI
query during rollout. Do not enumerate or retain unrelated zones.

Use the CLI to inspect the current cache phase:

```bash
npx --yes cf@0.5.0 rulesets phases get \
  http_request_cache_settings \
  --zone parasquid.dev
```

Filter the returned JSON locally. Do not retain or reproduce the full ruleset or its opaque IDs.
Confirm that any existing zone-level rules matching other `parasquid.dev` hostnames remain
unchanged.

Create only the proxied `awsm.parasquid.dev` CNAME record in the `parasquid.dev` zone, pointing to
the existing reference tunnel hostname. Resolve the tunnel target ephemerally from confidential
operator-managed state without printing or recording its opaque identifier. Inspect
`cf dns records create --help` and its schema, construct the smallest record body in process
memory, run the create command with `--dry-run`, and then perform the separately authorized
mutation. Do not copy, edit, replace, disable, or delete an existing DNS record. If
`awsm.parasquid.dev` already exists, stop and inspect it rather than overwriting it.

The DNS record and tunnel ingress rule are separate operations:

- Cloudflare DNS sends only `awsm.parasquid.dev` traffic to the existing reference tunnel.
- The remotely managed tunnel maps only that hostname to the isolated staging process.
- Any request with `Host: awsm.foo` continues to use the unchanged production route and process.
- Requests with an unexpected Host fail closed and never select staging.
- Updating remotely managed ingress should propagate without restarting the shared connector. If
  the verified deployment mode requires a connector restart or reload, stop and obtain separate
  authorization rather than interrupting production.

## 6.3 Cache Rule expression

Create a rule named:

```text
AWSM staging public Rails pages
```

Use the logical equivalent of:

```text
http.host eq "awsm.parasquid.dev"
and http.request.method in {"GET" "HEAD"}
and http.request.uri.path in {"/" "/privacy" "/security" "/glossary"}
```

Configure:

- cache eligibility: eligible for cache;
- Edge TTL: use the cache-control header if present, bypass cache if it is absent;
- Browser TTL: respect origin;
- cache key: use Cloudflare's default query-sensitive key and do not add any custom key dimensions;
- origin cache control: respect the origin headers;
- stale serving: allow the origin's `stale-while-revalidate` and `stale-if-error` directives; and
- origin error pages: preserve the existing deployed behavior.

Do not configure status-code TTL overrides. The application emits the Cloudflare cache header only
for successful public renders, and the rule's “header present, otherwise bypass” mode therefore
keeps redirects, `4xx`, and `5xx` responses out of cache without overriding origin TTL or stale
directives. Verify this empirically before rollout. If the active Cloudflare plan or ruleset cannot
provide that mode, stop the staging rollout and report the incompatibility; do not substitute a
broader cache policy.

Place this rule last among Cache Rules that can match these paths so its explicit settings win.
Use `cf rulesets rules create` when the named rule does not exist and `cf rulesets rules edit` when
it does. Supply the reviewed rule through the command's `--body` input, run `--dry-run`, inspect the
non-sensitive proposed expression/action summary, and only then perform the authorized mutation.
Re-inspect the cache phase after placement; do not guess rule order.

## 6.4 Tiered Cache

Smart Tiered Cache is a zone-wide setting and `parasquid.dev` may serve unrelated hostnames.
Inspect its current state without changing it:

```bash
npx --yes cf@0.5.0 cache smart-tiered-cache get \
  --zone parasquid.dev
```

If it is already enabled, staging may use it. If it is disabled, leave it disabled during this
plan. Do not alter a shared zone-wide cache setting merely to optimize one staging hostname.

## 6.5 Authentication, secrets, and automation

An interactive CLI OAuth profile is preferred for a one-time inspected rollout. Store its managed
authentication state only in the CLI's user-level configuration. Do not commit or copy the profile
binding into the repository.

An automated purge may instead use a narrowly scoped Cloudflare API token that can purge cache for
the `parasquid.dev` staging zone. Supply it as `CLOUDFLARE_API_TOKEN` through the host/deployment
secret system. The CLI can resolve the zone from `--zone parasquid.dev`, so automation does not
need to record the opaque zone identifier in tracked configuration.

Never place authentication values or operational identifiers in tracked configuration, shell
history captured as evidence, logs, screenshots, plan documents, or retained command output.

The repository currently does not define a canonical staging deployment pipeline. Therefore:

- do not invent a tracked placeholder secret;
- do not make a remote deploy part of the code commit;
- use the pinned `npx cf` command for the post-deploy purge;
- perform staging configuration/purge only after explicit remote-change authorization;
- never point staging automation at the production hostname; and
- automate the purge in the eventual canonical deployment workflow when that workflow is selected.

# 7. Invalidation, Warming, and Failure Behavior

## 7.1 Purge triggers

Purge all four canonical public URLs after:

- a successful deployment that can change Rails views, layouts, helpers, public JavaScript, public
  CSS references, public copy, route helpers, or registration rendering;
- changing `AWSM_PUBLIC_ORIGIN`;
- changing `AWSM_ACCOUNT_REGISTRATION_ENABLED`;
- rolling back any such deployment; or
- correcting a mistakenly cached public response.

Never purge an entire CDN zone when the four public URLs are sufficient. For AWSM reference
staging, dry-run one URL-purge request:

```bash
npx --yes cf@0.5.0 cache purge \
  --zone parasquid.dev \
  --body '{"files":["https://awsm.parasquid.dev/","https://awsm.parasquid.dev/privacy","https://awsm.parasquid.dev/security","https://awsm.parasquid.dev/glossary"]}' \
  --dry-run
```

Remove `--dry-run` only for the separately authorized post-deploy purge.

Fingerprint changes already produce new asset URLs, so do not purge immutable asset paths as part
of this operation.

## 7.2 Ordering

Use this exact deployment order:

1. deploy and health-check the new Rails revision;
2. confirm the four origin responses are successful and cache-safe;
3. purge the four environment-specific CDN URLs;
4. request each canonical URL once to warm it;
5. request each a second time;
6. confirm the second responses are CDN hits and contain the new revision's content; and
7. confirm representative dynamic routes remain uncacheable.

For rollback:

1. restore the prior healthy Rails revision;
2. confirm its public responses are cache-safe;
3. purge the same four URLs;
4. warm and verify again.

Never purge before a new healthy revision can answer misses. That would unnecessarily send visitors
to a broken or unavailable origin.

## 7.3 Cache verification

For each public URL, record only non-sensitive response facts:

- HTTP status;
- `Cache-Control`;
- `CDN-Cache-Control`;
- `CF-Cache-Status`;
- `Age`, when present;
- `Content-Type`; and
- an allowlisted public content marker.

Expected progression after purge:

```text
first request:  MISS or the provider's equivalent fill/revalidation status
second request: HIT with a positive/increasing Age when the provider supplies Age
```

CDNs cache per location and may legitimately report a miss from a new edge. For the AWSM reference
service, use Cloudflare Trace and Tiered Cache evidence to distinguish a rule failure from a
different edge fill.

For `/session/status`, `/sign_up`, `/account`, `/api/server-information`, and `/ready`, verify the
response does not report a shared public-page hit. Do not send real credentials or inspect Account
data during a cache smoke test.

## 7.4 Failure behavior

- If the CDN is bypassed or the object is evicted, Rails renders the page normally.
- If session-status fails, the public page remains anonymous and usable.
- If a hint is stale, Rails clears it and returns unauthenticated state.
- If the origin fails while the CDN has an eligible stale public object, the CDN may serve that
  public object within the declared stale window.
- Dynamic routes never use stale public objects.
- A public cache failure must not block signup, Account management, API synchronization, tickets,
  Cable, health, or readiness.
- A purge failure stops the rollout verification. Report it; do not claim the new public content is
  globally visible.
- A cached personalized response is a security incident: disable/bypass the rule, purge the four
  URLs, preserve non-sensitive diagnostic headers, and investigate before re-enabling.

# 8. Security and Privacy Review

Before GREEN completion, explicitly verify:

- the production route, process, CDN state, and mutable data were not changed by staging rollout;
- staging PostgreSQL, Redis, queue, storage, environment, and logs are distinct from production;
- the shared body is byte-equivalent across Account sessions;
- no signed-in username can enter the shared CDN;
- no CSRF token can enter the shared CDN;
- no `Set-Cookie` can be replayed from the shared CDN;
- the public layout does not force Rails to create a session;
- the hint contains random opaque bytes only;
- the hint cannot authorize Account, API, Vault, Device, transfer, or Cable access;
- session status is same-origin, private, and no-store;
- sign-out remains a CSRF-protected state-changing request;
- username insertion uses `textContent`;
- a forged status payload cannot inject markup;
- query variants remain representation-equivalent and, on reference staging, use distinct default
  cache keys rather than an unsupported custom override;
- the validated configured public origin, not an attacker-controlled Host, is rendered;
- no cache or hint value enters application logs;
- no new analytics, tracking, third-party script, remote font, or marketing cookie exists; and
- the server still receives no plaintext Vault content, Recovery Phrase, Device secret, or Vault
  key.

# 9. Rendered and Behavioral Acceptance

Inspect all changed Rails states at 1280-1440px desktop and the supported 390px narrow viewport:

1. anonymous public page before JavaScript;
2. anonymous public page with JavaScript;
3. signed-in loading shell;
4. signed-in resolved banner;
5. invalid/stale hint fallback;
6. status network-failure fallback;
7. open narrow navigation in anonymous state;
8. open narrow navigation in authenticated state;
9. sign-out transition; and
10. JavaScript-disabled public pages.

For each state verify:

- text contrast meets `AGENTS.md` and `DESIGN.md`;
- loading treatment does not expose placeholder Account data;
- header, footer, and banner links have correct accessible names;
- controls retain at least 44px interactive dimensions;
- focus remains visible;
- no username wraps into or overlaps another control;
- the banner does not create avoidable layout shift after the loading shell appears;
- there is no horizontal overflow or clipping;
- Turbo navigation does not leave stale authenticated DOM on a new page;
- failure leaves literal, understandable anonymous navigation; and
- reduced motion remains honored.

Update screenshot baselines only after personally viewing them. Do not accept baselines solely
because Playwright generated them.

# 10. Required Verification

Discover current commands from manifests at implementation time and use
`corepack pnpm`, never bare `pnpm`.

At minimum run:

```bash
docker compose exec -e RAILS_ENV=test coordination-server bundle exec rspec
docker compose exec -e RAILS_ENV=test coordination-server bundle exec rubocop
corepack pnpm design:check
corepack pnpm test:e2e:design
corepack pnpm exec prettier --check \
  docs/plans/17-cdn-cached-public-rails-pages.md \
  docs/plans/17-cdn-cached-public-rails-pages-tdd-evidence.md
git diff --check
```

Also run any narrower request or rendered test during RED/GREEN work and the broader repository
lint/check required by every changed TypeScript, JavaScript, Ruby, ERB, CSS, Markdown, or generated
asset.

Build the production Coordination Server image and inspect real production headers because
development caching behavior is not sufficient evidence:

```bash
docker build \
  -f apps/coordination-server/Dockerfile \
  -t awsm-coordination-plan17 \
  .
```

Start the image only with isolated test/development dependencies and non-secret test configuration.
Do not point it at deployed PostgreSQL, Redis, storage, or credentials. Confirm:

- public HTML uses fingerprinted assets;
- the public response has both cache headers;
- it emits no `Set-Cookie`;
- the session-status response is `private, no-store`; and
- dynamic routes do not inherit the public policy.

Cloudflare smoke verification at `awsm.parasquid.dev` is a separate, explicitly authorized staging
rollout step. Record only public response headers and cache statuses in the TDD evidence document;
never record tokens, zone identifiers, cookies, or user data. Do not send smoke requests to
the production origin.

# 11. Completion Checklist

Implementation is complete only when all of the following are true:

- [x] ERB remains the authored source of all four public pages.
- [x] The four public responses are safe, shared, and publicly cacheable.
- [x] Anonymous cached visits perform no Rails session-status request.
- [x] Signed-in display state is restored privately through `/session/status`.
- [x] The hint is non-authoritative, random, correctly scoped, and cleared on every revocation path.
- [x] Sign-out remains CSRF-protected.
- [x] No dynamic route receives the public caching contract.
- [x] The portable CDN contract and reference Cloudflare adapter are documented exactly and exclude
      errors.
- [x] No reference hostname, zone, provider credential, or server topology is an application
      default or runtime dependency.
- [x] Purge and rollback ordering are documented and tested without secrets.
- [x] Reference staging is reachable only at `awsm.parasquid.dev`.
- [x] Staging and production processes and mutable state are isolated, including when colocated.
- [x] Smart Tiered Cache state was inspected but no shared zone-wide setting was changed.
- [x] Request, browser, visual, production-image, formatting, and lint checks pass.
- [x] Every affected rendered state has been visually inspected.
- [x] README, architecture, testing, privacy/security copy, Plan 16, and Roadmap are reconciled.
- [x] The Plan 17 TDD evidence ledger contains contemporaneous evidence.
- [x] No Caddy, Varnish, static HTML, new dependency, tracking, or remote asset was introduced.
- [x] Production application processes, mutable state, hostname mapping, cache, and content remain
      unchanged throughout staging implementation and validation.
- [x] The shared tunnel change adds only the staging hostname-to-origin rule and preserves the
      production ingress rule exactly.
- [x] Only separately authorized staging infrastructure and the narrow shared-tunnel staging route
      were created or changed.

# 12. Implementation Handoff

An implementer starting cold should proceed in this order:

1. read repository-root `AGENTS.md`, the host override when present, `DESIGN.md`, and this entire
   plan;
2. inspect current git status and preserve unrelated user changes;
3. create the Plan 17 evidence ledger;
4. write the public-response RED tests;
5. implement the cache-safe layout and controller policy;
6. write and implement the session-status and hint-lifecycle tests;
7. write and implement the Stimulus behavioral and rendered tests;
8. reconcile all affected documentation and Roadmap language;
9. run the full verification in section 10;
10. inspect screenshots and production headers;
11. review the complete diff for secrets, stale personalization, and scope creep; and
12. stop before any staging mutation unless separate explicit authorization has been given, and
    never treat staging authorization as production-promotion permission.

Do not begin with CDN configuration. The shared representation must first be proven safe in the
repository and in an isolated production image. A cache amplifies whatever the origin emits;
therefore cache safety, cookie absence, and Account-body equivalence are release gates rather than
post-rollout checks.

# 13. AWSM Reference Adapter Sources

Use current official Cloudflare documentation during the separately authorized reference staging
rollout:

- unified `cf` CLI technical preview:
  <https://blog.cloudflare.com/cf-cli-local-explorer/>
- Cloudflare agent setup and unified CLI guidance:
  <https://developers.cloudflare.com/agent-setup/claude-code/>
- Cloudflare DNS record management:
  <https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/>
- Cloudflare Tunnel service-per-host guidance:
  <https://developers.cloudflare.com/cloudflare-one/troubleshooting/tunnel/>
- Cloudflare Tunnel terms and multiple-service routing:
  <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/tunnel-useful-terms/>
- Cloudflare Tunnel remotely managed configuration:
  <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/>
- Cache Rules: <https://developers.cloudflare.com/cache/how-to/cache-rules/>
- Cache Rule settings and header-present/bypass behavior:
  <https://developers.cloudflare.com/cache/how-to/cache-rules/settings/>
- Cloudflare-specific CDN cache-control header:
  <https://developers.cloudflare.com/cache/concepts/cdn-cache-control/>
- asynchronous stale revalidation:
  <https://developers.cloudflare.com/cache/concepts/revalidation/>
- Cache Rule order and priority:
  <https://developers.cloudflare.com/cache/how-to/cache-rules/order/>
- Smart Tiered Cache:
  <https://developers.cloudflare.com/cache/how-to/tiered-cache/>
- single-file purge:
  <https://developers.cloudflare.com/cache/how-to/purge-cache/>

Cloudflare is mutable external state. If its current official interface or behavior conflicts with
this plan, do not silently reinterpret the cache or privacy contract. Stop the staging rollout,
record the exact conflict without secrets, and return for an explicit plan amendment.
