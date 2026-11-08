# MindSpark Home

A small self-hosting wrapper around [MindSpark](https://github.com/prasadpatil25/MindSpark),
an open-source mind-mapping app, for households and small trusted groups.

Upstream MindSpark's self-hosted server keeps every map in one shared space. To
keep maps private it relies on GitHub-backed cloud storage, so each person needs
a GitHub account. MindSpark Home adds:

- **Local accounts:** username and password, managed from the command line. No
  third-party sign-in and no public registration.
- **Private maps:** each user has their own maps and version history, and the
  server checks ownership on every request.
- **Nested folders:** a file-manager-style library, with a folder tree on the
  left and maps on the right. The editor shows breadcrumbs back to the folder.
- **Simple deployment:** a single Docker container with one SQLite database in a
  persistent volume. There are no external services and no runtime npm
  dependencies.

The editor itself is MindSpark's own, including templates, import/export,
autosave and snapshot sharing.

## Relationship to MindSpark

MindSpark is vendored as a Git submodule in [`MindSpark/`](MindSpark) and
pinned to an exact commit. The wrapper serves MindSpark's browser assets and
implements its storage API. It does not run MindSpark's own server.

The wrapper depends on a small, opt-in hosting adapter (`window.MINDSPARK_HOST`)
that has been proposed upstream. Until it is merged, the submodule points at a
fork containing that adapter. With no host present, MindSpark behaves exactly as
before. Accounts, the database schema and the folder UI live only in this
repository.

See [docs/architecture.md](docs/architecture.md) for the design, security
boundaries and limitations.

## Quick start (Docker)

```sh
git clone --recurse-submodules https://github.com/optilude/mindspark-home.git
cd mindspark-home
cp .env.example .env        # set APP_ORIGIN at minimum
docker compose up -d        # or: docker compose up -d --build
docker compose exec app node admin.mjs add alice
```

Then put the app behind an HTTPS reverse proxy (see below) and browse to
`APP_ORIGIN`.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_ORIGIN` | `http://localhost:3000` | Public origin, e.g. `https://maps.example.com`. Must be HTTPS except on localhost, with no subpath. |
| `DB_PATH` | `data/home.db` (`/data/home.db` in the container) | SQLite database file. |
| `PORT` / `BIND_HOST` | `3000` / `0.0.0.0` | Listen address inside the container or process. |

`.env.example` also sets Compose-only values: `IMAGE`, `DATA_PATH`,
`BIND_ADDRESS` and `HOST_PORT`.

### Reverse proxy requirements

- Terminate TLS at the proxy and forward plain HTTP to port 3000.
- Preserve the original `Host` header. The app checks `Host` and `Origin`
  against `APP_ORIGIN` and ignores `X-Forwarded-*` headers.
- Serve the app at the root of the host name, not under a path prefix.
- Allow request bodies of at least 16 MB, and don't cache responses.
- Never expose port 3000 directly to the Internet.

## Managing users

```sh
docker compose exec app node admin.mjs add alice             # prompts for password (8+ characters)
docker compose exec app node admin.mjs list
docker compose exec app node admin.mjs reset-password alice
docker compose exec app node admin.mjs disable alice         # or: enable
docker compose exec app node admin.mjs delete alice --confirm
```

Users can change their own password from the library.

## Backups

The database runs in SQLite's write-ahead-log (WAL) mode, so copying `home.db`
while it is running can miss recent changes. Use the built-in online backup
instead:

```sh
docker compose exec app node admin.mjs backup /data/backups/home-YYYY-MM-DD.db
```

See [docs/operations.md](docs/operations.md) for:
- restore steps;
- importing an existing MindSpark SQLite database;
- upgrades;
- NAS deployment notes, with TrueNAS SCALE as the example.

## Development

Requires Node **22.16+**. There is no install or build step.

```sh
node admin.mjs add alice
npm start                    # http://localhost:3000
npm test                     # wrapper tests
npm --prefix MindSpark test  # MindSpark tests
```

GitHub Actions runs both test suites, smoke-tests the container and publishes
multi-architecture images to GHCR. Pushes to `main` publish `latest`, and `v*`
tags publish versioned images.

## License

MIT, as is MindSpark. See [LICENSE](LICENSE).
