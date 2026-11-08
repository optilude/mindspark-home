# Architecture and upstream review

## Reviewed baseline

Fork `optilude/MindSpark` matched upstream `prasadpatil25/MindSpark` at `fc47212`
when inspected. Its 1,487 baseline tests passed under Node 22.23.2.

Reviewed persistence and history in `server.js`; the storage adapters, forge
index reconciliation, boot, map list, autosave and shared-copy flows in
`public/app.js`; service-worker caching; Cloudflare identity/import boundaries;
Docker, licensing, contribution rules, and CI.

Key findings:

- The self-hosted API has a single SQLite map namespace and no local accounts.
  A login page or forward-auth proxy around that instance would authenticate
  access, but would not separate anyone's maps.
- The cloud adapter writes to each user's git forge. Worker identity/ACL code
  is for the cloud collaboration service, not ownership of self-hosted SQLite
  maps. It is not a drop-in local password backend.
- The editor is vanilla JavaScript, one classic script with no build step.
  Its storage API is small: list/get/save/remove/history/version.
- Browser state includes templates, prompt variables and provider credentials
  as well as cosmetic preferences. Per-user server storage alone is incomplete
  for ordinary account switching in a shared browser.
- `ServerStore` catches read failures as empty/null results, retries failed PUT
  as POST, and warns rather than rejecting failed deletes. These standalone
  semantics are unsuitable for an authenticated/concurrency-guarded host.
- Upstream history coalesces saves within a minute and keeps 50 snapshots.
  The wrapper preserves this model.
- Docker and non-root volume handling already exist upstream. The missing
  part is a multi-user storage/authentication boundary, not Docker support itself.
- The MIT license allows vendoring with attribution. Its contribution guidance
  explicitly prefers focused PRs, zero runtime dependencies and no build step.

## Chosen boundary

```text
Browser: https://one-configurable-origin
                 |
nginx-proxy-manager: HTTPS termination, original Host preserved
                 |
MindSpark Home: local passwords, sessions, CSRF, ownership, folders
    |                       |
SQLite /data/home.db         Pinned MindSpark editor assets
```

The wrapper does not start or expose upstream `server.js`. It serves the editor
and implements its storage contract directly, so there is no unauthenticated
back door or one background server process per family member.

Maps and versions use `(owner,id)` keys. Every operation derives the owner from
a server-verified session. Folder access validates owner membership, including
destination parents and map moves. Cycle checks run in a transaction; non-empty
folder deletion is refused rather than cascading away maps.

Nested folders are hosting metadata in a dedicated library. Autosaves cannot
overwrite folder membership, and importing a map cannot choose another owner's
folder. This keeps changes to the original editor extremely small. It is an
intentional UX difference from adding folders directly to MindSpark's sidebar.
The library presents an expandable folder tree and the selected folder's contents,
with per-item action menus. My maps is the top-level folder. The hosted editor
lists only sibling maps and has a persistent Back to folders link plus clickable
breadcrumbs above its canvas; the URL retains the folder selection. New maps in
the editor inherit that folder, including retries if assignment fails.

### Authentication

- Passwords use salted scrypt (N=32768, r=8, p=1, 64-byte keys), asynchronous
  hashing and timing-safe digest comparison.
- Unknown accounts undergo the same hashing work. Authentication work is bounded.
- Random opaque sessions are stored as SHA-256 token hashes in SQLite and expire
  after 12 hours. No JWT signing key or reusable plaintext bearer token is stored.
- Production cookies use `__Host-`, Secure, HttpOnly, SameSite=Strict and Path=/.
- Mutations require the exact configured Origin and session-bound CSRF token.
  No CORS access or trusted client-supplied forwarded identity exists.
- Login attempts are limited per username and immediate peer address. The proxy
  IP limit is higher because family users share it. This limiter is in memory,
  resets on process restart, and is not a distributed edge/WAF substitute.
- Password resets, password changes and disable/enable revoke existing sessions.
  CLI administration needs access to the container/volume, not a web admin account.

### Shared-browser behavior

Editor URLs are `/w/IMMUTABLE_USER_ID/`. Login rotates the browser session. The
server rejects a previous user's workspace URL if another account is now signed
in, including delayed autosaves and version requests. Library requests carry an
expected workspace ID; stale library pages cannot silently show another account.

A wrapper bootstrap script loads before the editor and its pre-paint code.
Classic-script lexical `localStorage` and `sessionStorage` adapters namespace
all normal editor storage operations by immutable user ID, including enumeration
and clearing preferences, without replacing browser APIs.

This is **account-switching isolation, not a browser security sandbox**. All users
share an origin. Someone with developer tools in the same browser profile can
inspect that profile's storage, and an XSS or malicious same-origin script could
access it. Use separate browser/OS profiles on shared devices if saved AI keys
are sensitive. Server map ownership does not depend on browser namespaces.

The hosted editor does not register its offline service worker. Authenticated
HTML/API responses use `no-store`; editor assets use private revalidation.
Offline editing is not promised: keep the tab open, export edits if a save fails,
and restore connectivity. Existing unsaved-work guards remain in use.

### Concurrent editing and errors

GET/save returns a content ETag. Existing saves require the previously read token;
new maps require `If-None-Match: *`. Stale writes, deleted-map writes and unguarded
overwrites fail with 412. There is no unconditional POST fallback. A conflict
does not silently adopt a new token; export edits and reload to resolve it.

This prevents lost updates but is not merging or real-time collaboration.
The editor's save runner serializes writes per map within a tab. Multiple tabs
and devices receive explicit conflicts.

Failures propagate from the hosted adapter and display a persistent error
banner, with a route back to login/library. Hosted boot failures do not invent
an empty library or switch to GitHub. Account expiry does not silently redirect
away from an editor containing unsaved work.

Network failures and proxy 502/503/504 responses during a save are transient.
The adapter keeps retrying the save with backoff, up to 15 seconds apart, so the
editor shows "Saving…", warns before the tab closes, and queues later edits. The
banner clears once a request succeeds. A lost response may hide a write that
reached the server. The adapter keeps the bodies of saves whose outcome is
unknown. If a 412 follows, it re-reads the map and adopts the new token only if
the stored content matches one of those bodies. Any other change remains a
conflict. Saves that fail for good also trigger an unload warning. `keepalive`
is used only for saves started while the page is hidden. Browsers share a
64 KB keepalive quota per page, so one stalled request would make every later
save fail at once with "Failed to fetch".

### Data and deployment

One SQLite database contains users, hashed sessions, maps, folders and versions.
Foreign keys and immediate transactions enforce consistency; WAL and a busy
timeout allow the server and admin command to coexist. Schema versions are
checked before startup. Backups use the SQLite backup API, not live-file copying.

One unprivileged Node 24 container serves everything. TrueNAS supplies a local
dataset; NPM terminates HTTPS. There is no Redis, cloud worker, GitHub account
dependency, or third-party password service.

Maps and backups are not application-encrypted. Protect the NAS dataset, backups
and administrative access; use ZFS encryption if required.

## Focused upstream contribution

`MindSpark/` is pinned to your fork. `feat/hosted-storage-adapter` contains only:

1. An opt-in `window.MINDSPARK_HOST` store/readiness/error contract.
2. Fail-closed hosted boot/load behavior; standalone defaults stay unchanged.
3. An optional snapshot-link base URL.
4. Skipping offline service-worker registration for hosted deployments.
5. Focused tests and contribution documentation.

The wrapper injects its own bootstrap script at the existing charset marker in
the served HTML, not into the vendored files on disk. Startup checks fail loudly
if either that marker or the host contract disappears during an upgrade.

No family account model, database schema or wrapper UI is proposed upstream.
The small generic host adapter can be submitted as one focused PR; upstream may
prefer a different embedding contract, so acceptance is not assumed.

Suggested PR title: **Add an opt-in storage adapter for authenticated hosts**.
Explain why authenticated hosts cannot use silent empty-read fallbacks, and
include both standalone and opt-in regression results.

## Verification

Automated wrapper checks exercise actual HTTP responses and SQLite:

- Anonymous access; Host, Origin and CSRF rejection.
- Colliding map IDs in separate accounts; history and static workspace isolation.
- Conditional writes and prevention of deleted-map resurrection.
- Nested folder cycles, cross-account parents/moves and non-empty deletion.
- Folder membership across autosaves.
- Invalid JSON, malformed maps/IDs and measurable request-size limits.
- Password/session revocation and disabled accounts.
- Storage namespace enumeration/clear and hosted adapter failure propagation.
- CLI passwords, persistent backups, schema downgrade refusal and atomic
  upstream SQLite migration, including history retention of exactly 50 versions.

The upstream adapter tests exercise the shipped functions through the project's
existing extraction harness. The full upstream suite is retained.

For browser regression checks, sign in, create nested folders and a map, edit it
until Saved, reload, move it, and open a snapshot from another account. Open two
tabs on one map to verify conflict handling. Switch accounts in another tab and
verify the stale editor cannot read/save into the new account. Check desktop and
narrow layouts, import/export, preferences and version restoration.

The GitHub workflow additionally builds the Docker image and verifies a volume
survives container restart. A local Docker daemon was not available during
initial development; real TrueNAS/NPM deployment must still be verified on
your NAS before treating it as production-ready.

Initial verification on 2026-11-07:

- All 21 wrapper tests and 1,492 upstream tests passed (including five new
  upstream adapter tests).
- JavaScript syntax, YAML and Compose configuration validation passed.
- A real browser exercised login, nested folder creation, map creation,
  autosave/reload, moving maps, snapshot viewing/copying, a 412 concurrent-save
  conflict, and a 403 stale-editor write after switching accounts.
- The library had no horizontal overflow at a 390-pixel viewport.
- The integrated browser had intermittent actionability/scale issues with
  upstream controls; some later checks invoked their existing click handlers
  programmatically. This is not full automated visual/editor regression coverage.
- Docker build/run is intentionally left to GitHub CI, as requested; no local
  Docker VM was started. TrueNAS and NPM have not been exercised here.
