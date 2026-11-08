# Operations

Deployment, administration and maintenance details for MindSpark Home. Start
with the [README](../README.md).

## Deploying on a NAS (TrueNAS SCALE example)

The same steps apply to other Docker hosts.

1. Create a dedicated dataset for the data, e.g. `/mnt/tank/apps/mindspark-home`.
   Use local storage: SQLite must not run on an SMB or NFS mount.
2. Give UID/GID **1000:1000** read, write and traverse access to the dataset.
   The container runs as this non-root user. Don't run it as root to work
   around permissions.
3. In `.env` (or the equivalent Custom App settings), set:

   ```dotenv
   APP_ORIGIN=https://maps.example.com
   IMAGE=ghcr.io/OWNER/mindspark-home:0.1.0
   DATA_PATH=/mnt/tank/apps/mindspark-home
   BIND_ADDRESS=192.168.1.20   # NAS private IP, reachable by the proxy
   HOST_PORT=3000
   ```

   Pin a version tag or digest rather than `latest`.

   By default `BIND_ADDRESS` is `127.0.0.1`. A proxy running in another
   container cannot reach that address. Either bind to the NAS's private IP, or
   put the proxy and the app on a shared Docker network and remove the published
   port.
4. Start the app with `docker compose pull && docker compose up -d --no-build`,
   or translate the single Compose service into a Custom App.

### nginx-proxy-manager

- Create a Proxy Host for the domain:
  - Forward scheme: **http**, to the NAS IP (or service name) and port 3000.
  - Request a Let's Encrypt certificate and enable Force SSL.
- Leave Host forwarding at its default, which preserves the original Host.
- Under Advanced, add `client_max_body_size 16m;`. Map requests are limited to
  8 MiB by the app itself.
- Do not enable caching for this host.

The container runs:
- as a non-root user;
- with a read-only root filesystem;
- with all capabilities dropped and `no-new-privileges`;
- with a tmpfs `/tmp`;
- with `/data` as its only writable path.

Run only one replica per database file.

If the image on GHCR is private, make the package public, or log in to GHCR
on the Docker host with a token that has `read:packages`.

## Administering accounts

Run the `admin.mjs` commands from the README with
`docker compose exec app node admin.mjs …`. From a container shell, or with
`docker exec -it CONTAINER node /app/admin.mjs …`, use `node /app/admin.mjs …`.

- Changes take effect immediately, with no restart.
- Password resets, disable/enable, and a user changing their own password all
  sign out that user's existing sessions.
- `delete` permanently removes the user's maps, history and folders, and
  requires `--confirm`.
- There is no public registration, email-based reset or default admin account.

Without an interactive terminal, pipe the password through stdin:

```sh
docker compose exec -T app node admin.mjs add alice < /secure/path/password.txt
```

Delete the file afterwards. Don't put real passwords in command arguments,
`echo` commands, Git, images or Compose files.

## Backup and restore

While the app is running, the data directory contains `home.db` and its
SQLite WAL and SHM files. **Do not copy a live `home.db` on its own.**
Use the online backup instead:

```sh
docker compose exec app node admin.mjs backup /data/backups/home-YYYY-MM-DD.db
```

The backup target must not already exist. Store copies off the host and protect
them: they contain map contents, password hashes and session records.
Filesystem snapshots are useful, but they don't replace tested off-host backups.

To restore:

1. Stop the app.
2. Move the current data, including the WAL and SHM files, somewhere safe.
3. Place the backup as `home.db` in an empty data directory.
4. Reapply UID/GID 1000 ownership and start the app.
5. If the backup may have been exposed, reset passwords. Resetting a password
   also revokes that user's sessions.

## Importing an upstream MindSpark database

Stop the old MindSpark server, or take a consistent SQLite backup of it, then
make the database file available inside the container:

```sh
docker compose exec app node admin.mjs import-sqlite alice /data/import/mindspark.db
```

- The source is opened read-only.
- Map IDs and recency are preserved, along with up to 50 versions per map.
- If any map ID already exists for the target user, the whole import is
  aborted without changes.
- Imported maps start in **My maps**.
- For maps held in MindSpark cloud storage, use the editor's JSON export and
  import instead.

## Upgrading

1. Back up the database.
2. Pull the new image tag and recreate the container with the same `/data`
   mount.

The app refuses to open databases created by a newer schema version. Rolling
back to an older version may require restoring the pre-upgrade backup.

## Updating the vendored MindSpark

1. Merge upstream changes into the submodule's adapter branch, or, once the
   adapter is merged upstream, point the submodule at upstream.
2. Run both test suites and the browser checks in
   [architecture.md](architecture.md).
3. Push the submodule commit.
4. Commit the updated submodule pointer in this repository.

Always push the submodule commit before the wrapper commit, because CI must be
able to fetch the exact pinned commit. MindSpark is never patched at build time
or downloaded at runtime.
