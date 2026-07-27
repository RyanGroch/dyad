# Coolify Phase 0 spike

Answers one question: can a single API integration replace the SSH scaffold
(1.0), systemd server-runtime (1.2), and Docker Compose Postgres (2.2)?

Deploys from a **private** git repo using a deploy key — the case that matters
for the privacy motivation. Public repos are not tested.

## Setup

1. **Droplet:** Ubuntu 22.04/24.04 LTS, at least 2 CPU / 4 GB RAM / 40 GB disk.
   (Coolify's own minimum is 2/2/30; its stack eats ~1 GB before your app, and
   the Node build runs on the same box.)

2. **Install Coolify** as root:
   ```
   curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash
   ```
   Then immediately visit `http://YOUR_IP:8000` and create the admin account —
   the registration page is open until someone claims it.

3. **API token:** Coolify UI -> Keys & Tokens -> API tokens. It needs **all
   four** of these scopes (or just `root` for a throwaway spike):

   | Scope | Needed for |
   |---|---|
   | `read` | listing servers, projects, applications |
   | `read:sensitive` | reading the database connection strings |
   | `write` | creating projects, databases, apps, env vars, keys |
   | `deploy` | triggering deployments and restarts |

   Scopes are fixed when the token is created — to change them, make a new
   token. A token missing `write` fails at step 1 with
   `403 Missing required permissions: write`.

4. **Firewall:** allow `8000` (dashboard), `80`/`443` (apps), `22` (SSH), and
   `5433` (the public Postgres port this script uses). If 5433 is blocked, step
   6 reports a false negative about Coolify.

5. **Test app:** push `testapp/` to a **private** git repo. Any SSH-reachable
   host works — GitHub, GitLab, or a self-hosted Gitea.

## Run

```
COOLIFY_URL=http://YOUR_IP:8000 \
COOLIFY_TOKEN=xxx \
TEST_REPO=git@github.com:you/coolify-phase0-testapp.git \
node phase0.mjs
```

`TEST_REPO` must be the **SSH form** (`git@host:owner/repo.git`). Deploy keys
are SSH keys; an `https://` URL will not authenticate.

Those three variables are all you need. The first run generates a keypair at
`~/.ssh/coolify_phase0_ed25519`, finds it can't read the repo, prints the public
key with instructions, and exits **without creating anything in Coolify**. Add
the key as a deploy key (read-only is enough), then re-run.

`DEPLOY_KEY_PATH` is optional — set it only to put the key somewhere other than
the default, or to reuse an existing one. It's the path to the *private* key
with no extension; the public half is read from `<path>.pub`.

Takes ~5-10 minutes, mostly the real build. Prints a findings summary and the
delete commands for what it created.

Re-running is safe: it reuses an existing `phase0-db-*` / `phase0-app-*` rather
than colliding on the public port. To start completely fresh:

```
CLEANUP=1 COOLIFY_URL=... COOLIFY_TOKEN=... TEST_REPO=... node phase0.mjs
```

## What it answers

1. Can Dyad discover servers/projects/environments via API?
2. Does a deploy key grant access to the private repo? (checked with
   `git ls-remote` before touching Coolify)
3. Can Dyad register that deploy key via API, with no UI step?
4. Does the API expose the DB connection string? (needs `read:sensitive`)
5. Can Dyad reach the DB externally to run migrations?
6. Is the public DB port actually open from outside?
7. Can Dyad create an app from a **private** repo via API?
8. Can Dyad wire the DB into the app via API?
9. Can Dyad poll deployment status?
10. Does the app get a working URL with no DNS setup?
11. Does the deployed app reach Postgres over the internal network?
12. **Does data survive an app redeploy?**
13. **Does data survive a database restart?** (volume persistence)

12 and 13 are the ones that matter. Everything can look perfect until a
redeploy silently wipes the data.

## Files

- `phase0.mjs` — the driver. No npm dependencies; needs Node 18+, git, ssh.
- `testapp/` — minimal Express + pg app (health, migrate, write, read).
- `mock_coolify.mjs` — fake API used to validate the driver's logic offline.
  Run `MOCK_PORT=8899 node mock_coolify.mjs`, then point `phase0.mjs` at it with
  `PHASE0_SPEED=60` and a local bare repo as `TEST_REPO`. It validates *this
  script*, not Coolify — every "YES" from a mock run is self-produced.

## Known before running

From Coolify's OpenAPI spec and `StandalonePostgresql.php`:

- `POST /security/keys` takes the private key and returns the
  `private_key_uuid` that `POST /applications/private-deploy-key` needs — so
  key registration is fully API-driven, no UI step, and no GitHub App required.
- `internal_db_url` is `postgres://user:pass@{db-uuid}:5432/db` — the host is
  the container name, resolvable only inside Coolify's docker network. This is
  what the app uses.
- `external_db_url` returns **null** unless `is_public && public_port`. The
  script sets `is_public: true` deliberately, to test whether migrations from
  Dyad's machine are possible at all.
- Both URLs are in the model's `$hidden` list; `read:sensitive` unhides them.
- `autogenerate_domain` defaults true, falling back to sslip.io — so an app
  should get a URL without any DNS work.
- `build_pack` options: `nixpacks`, `railpack`, `static`, `dockerfile`,
  `dockercompose`. Nixpacks auto-detects the Node app.
- `public_port_timeout` (default 3600s) exists on the DB model; whether it
  auto-closes the port is unconfirmed — worth checking after an hour.
