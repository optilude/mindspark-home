# MindSpark Home

Single-domain, private family hosting for [MindSpark](https://github.com/prasadpatil25/MindSpark).
Family members need only a local username and password, not GitHub accounts.

- Nested folders in a separate library: create, rename, move, and delete empty folders.
- Private maps and version history, with ownership enforced by the server.
- The original MindSpark editor, templates, import/export, and autosave.
- Password changes in the library; account administration through container commands.
- One Docker container, no external services or runtime npm dependencies.
- SQLite in a persistent volume; consistent online backups.

Folders are managed in the library, **not in the editor's sidebar**. The editor has
a **Library / username** link and still lists all your maps. Maps created in the
library inherit the selected folder; maps created inside the editor start unfiled.
Folder membership is hosting metadata, not part of exported map JSON.

Snapshot share links can be opened by other family accounts after signing in.
They contain a copy of the map in the URL fragment; they do not grant access to
the owner's stored map or update when it changes. Anonymous public viewing and
live collaboration are deliberately not enabled.

See [architecture and code review](docs/architecture.md) for the rationale,
integration boundary, and limitations.

## Repository setup and first push

This directory is its own repository. `MindSpark/` is a submodule of your fork.
The small editor hosting adapter is on `feat/hosted-storage-adapter`, separate
from the wrapper, so it can be proposed upstream independently.

Before publishing the wrapper, **push the submodule commit first**. GitHub Actions
must be able to fetch the exact recorded commit from your fork:

```sh
git -C MindSpark push -u origin feat/hosted-storage-adapter
git remote add origin https://github.com/YOUR_ACCOUNT/mindspark-home.git
git push -u origin main
```

No remote repository or pull request is created automatically. For a fresh clone:

```sh
git clone --recurse-submodules https://github.com/YOUR_ACCOUNT/mindspark-home.git
cd mindspark-home
```

Do not replace the submodule with upstream `main` until the hosting adapter has
been merged there. Startup checks deliberately reject a missing integration.

## Local development

Use Node **22.16+**, preferably Node 24, for built-in SQLite and its backup API.
There is no install or build step:

```sh
node admin.mjs add alice
npm start
# Open http://localhost:3000
```

The administrator command prompts for a hidden password on a terminal. Passwords
must have at least 12 characters. Never put real passwords in command arguments,
Git, image layers, or deployment configuration.

`APP_ORIGIN` defaults to `http://localhost:3000` locally. For another port, set both:

```sh
APP_ORIGIN=http://localhost:3100 PORT=3100 npm start
```

HTTP is allowed only on localhost. Production requires an explicit HTTPS origin.
The server validates the original Host and Origin, rather than trusting forwarded
headers. Always browse using the configured origin.

```sh
npm test
npm --prefix MindSpark test
```

## Build and publish from GitHub

The included Actions workflow runs both test suites, builds and smoke-tests the
container, then publishes `linux/amd64` and `linux/arm64` images to:

```text
ghcr.io/YOUR_ACCOUNT/YOUR_REPOSITORY
```

Pushes to `main` publish `latest` and a SHA tag. Tags such as `v0.1.0` publish a
version tag. Pull requests test but do not publish. Choose a version or image
digest for dependable deployments rather than following `latest` blindly.

GitHub container packages can initially be private. Either make the package
public, or authenticate TrueNAS/Docker to GHCR with a token that has
`read:packages`. The initial workflow cannot run until the submodule commit is
available on GitHub.

To build locally when Docker is running:

```sh
cp .env.example .env
# Edit .env: APP_ORIGIN, IMAGE, DATA_PATH, and BIND_ADDRESS.
docker compose up -d --build
```

If your installation provides standalone `docker-compose` rather than the
`docker compose` plugin, substitute that executable in these commands.

To deploy a published image without building:

```sh
docker compose pull
docker compose up -d --no-build
docker compose logs -f app
```

## TrueNAS SCALE and nginx-proxy-manager

Use SCALE's Docker/Custom App support with this Compose definition, or translate
its single service into a Custom App:

1. Create a dedicated dataset, e.g. `/mnt/tank/apps/mindspark-home`.
2. Give the container's **UID/GID 1000:1000** write/traverse access through the
   dataset ACL. Do not run the container as root to bypass permissions.
3. Mount that dataset at `/data`. Set `DB_PATH=/data/home.db`.
4. Set `APP_ORIGIN=https://maps.your-domain.example`, with no subpath.
5. Expose container port 3000 to a trusted private network. Point NPM at that
   NAS IP and port with forwarding scheme **HTTP**.
6. Create one Proxy Host, obtain its Let's Encrypt certificate, and enable
   Force SSL. NPM must forward the original Host (its normal default).
7. Set `client_max_body_size 16m;` in the Proxy Host's Advanced configuration.
   The application separately limits map request JSON to **8 MiB**.
8. Ensure there is no proxy caching of authenticated responses. Do not add a
   path prefix or expose the upstream MindSpark server separately.

For Compose, set for example:

```dotenv
APP_ORIGIN=https://maps.your-domain.example
IMAGE=ghcr.io/YOUR_ACCOUNT/mindspark-home:0.1.0
DATA_PATH=/mnt/tank/apps/mindspark-home
BIND_ADDRESS=192.168.1.20
HOST_PORT=3000
```

Replace the NAS IP, dataset and version with real values. If NPM is on a shared
Docker network, omit the published port and connect both services to that network;
NPM can then forward to the app's service name. The Compose default binds
localhost, which **another container cannot reach via its own localhost**.
Do not publish port 3000 directly to the Internet.

Container settings: non-root, read-only root filesystem, all capabilities dropped,
`no-new-privileges`, `/tmp` tmpfs, and writable `/data`. This is one server instance;
do not run multiple replicas against the same SQLite file. Use a local ZFS
dataset, not an SMB/NFS-mounted database.

## Administering a running container

With Compose:

```sh
docker compose exec app node admin.mjs add alice
docker compose exec app node admin.mjs add bob
docker compose exec app node admin.mjs list
docker compose exec app node admin.mjs reset-password alice
docker compose exec app node admin.mjs disable alice
docker compose exec app node admin.mjs enable alice
```

For TrueNAS's container shell, run the same `node /app/admin.mjs ...` commands.
Alternatively use `docker exec -it CONTAINER_NAME node /app/admin.mjs add alice`.
Creating an account does not require a restart. Password resets and disable/enable
invalidate that user's existing sessions. Users can change their own password in
the library; this signs out all of their sessions.

If no interactive terminal is available, pipe a password through stdin:

```sh
docker compose exec -T app node admin.mjs add alice < /secure/path/password.txt
```

Protect that temporary file and remove it after use. Do not use an `echo` command
containing a real password, as it would enter shell history.

Account deletion removes maps, history and folders permanently and requires a
separate confirmation flag:

```sh
docker compose exec app node admin.mjs delete alice --confirm
```

Back up first. There is no public registration, email reset service, or default
administrator password.

## Backup, restore and migration

The volume contains `home.db` and SQLite WAL/SHM files while running. **Do not copy
only a live `home.db`**: recent writes may still be in its WAL.

Make a consistent online backup using Node's SQLite backup API:

```sh
docker compose exec app node admin.mjs backup /data/backups/home-2026-11-07.db
```

The target must not already exist. Copy the completed backup off the NAS and
protect it: it contains map contents, password hashes and active session records.
NAS snapshots complement, but do not replace, tested off-host backups.

Restore:

1. Stop the application.
2. Preserve the current dataset, including its WAL/SHM, elsewhere for recovery.
3. Restore the completed backup as `/data/home.db` into an empty application
   dataset; do not mix it with WAL/SHM files from a different database state.
4. Restore UID/GID 1000 ownership/ACL and start the application.
5. Reset passwords if the backup may have been exposed; resets revoke sessions.

Import an existing upstream MindSpark database into a particular account:

```sh
# Stop the OLD MindSpark server before copying its database, or obtain an
# independently consistent SQLite backup. Copy/mount it into this container.
docker compose exec app node admin.mjs import-sqlite alice /data/import/mindspark.db
```

The source is opened read-only. Imports preserve map IDs and recency and up to
50 versions per map. Duplicate IDs in the target cause the entire import to
abort without changes. Imported maps start unfiled. For cloud-stored maps, use
the existing JSON export/import in the editor.

## Updating

Back up before every upgrade. Pull your chosen image tag/digest, then recreate
the container with the same `/data` mount. The application refuses databases from
a newer schema rather than silently downgrading them. Downgrades may require
restoring a pre-upgrade backup.

To update vendored MindSpark, first review upstream changes and merge them into
your adapter branch. Run both suites and the browser checks in
[architecture and testing](docs/architecture.md), commit the submodule there,
push it, then commit the updated submodule pointer here. No runtime downloads,
floating branches, or textual patching of the editor JavaScript are used.
