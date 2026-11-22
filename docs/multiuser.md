# Trusted multi-user deployment

This guide describes the single-container, trusted multi-user mode. Every user
signs in through the same `https://chat.codeorbita.com` URL with Traefik and
Authelia, and the container runs one DeepSeek Harness process per Authelia
identity. No per-user container is created.

> **Trust boundary:** this mode is for trusted users. All DSH processes run as
> the same `node` UID in the same container. A user with shell or tool execution
> can read other users' files if they know the paths. The workspace and picker
> plugins enforce product policy, not OS isolation. Use separate containers,
> per-user UIDs, or stronger sandboxing if file-level isolation is required.

## Why one process per user

DSH is process-scoped. `$DSH_HOME` contains profiles, model settings, provider
credentials, sessions, storages and browser state; the Web carrier has one owner
Peer per process. A single DSH process cannot switch users per request, and
there is no built-in per-user account model. The only way to give each Authelia
identity its own configs, sessions and workspace tree without multiple
containers is one `dsh web` child per user inside one container.

The container therefore has:

- one pinned DSH image;
- one supervisor + gateway process;
- one `dsh web` process per configured user, each on a loopback port;
- one users volume with a directory per user;
- Chromium/noVNC and Browser Use disabled to keep the resource footprint low.

## Architecture

```text
Browser -> https://chat.codeorbita.com
        -> Traefik TLS + Authelia forward-auth
        -> Remote-User: alice / alice-groups
        -> dsh-multiuser container :8080
             gateway checks X-DSH-Proxy-Secret and Remote-User
             gateway -> 127.0.0.1:3080 (alice)
             gateway -> 127.0.0.1:3081 (bob)
             alice: DSH_HOME=/workspace/alice/.dsh
             bob:   DSH_HOME=/workspace/bob/.dsh
```

The gateway:

- rejects a request without the Traefik-added `X-DSH-Proxy-Secret`;
- maps `Remote-User` to exactly one configured user;
- optionally requires one of the user's `allowedGroups` from `Remote-Groups`;
- rewrites DSH cookies to `dsh-<user>-auth-...` so one browser can hold
  sessions for several users, and only forwards the target user's DSH cookie;
- adds `Secure` to DSH cookies when the public URL is HTTPS;
- captures each child's launch token from stdout and injects it only on a root
  request that returns 401. The token never appears in the browser URL, browser
  history, or container logs;
- proxies HTTP and WebSocket traffic to the child's loopback port;
- returns 503 while a user process is starting, 502 when it is unavailable.

## Prerequisites

- A Docker host.
- An existing Traefik instance with a TLS entry point and certificate resolver.
- An existing Authelia instance with forward-auth and a group or user list for
  the DSH users. The examples use a `dsh-users` group for `chat.codeorbita.com`.
- DNS for the public host and a certificate for it.
- The standard `runzhliu/deepseek-harness` image; the multiuser scripts and
  plugins are mounted from this checkout.
- A host or named volume mounted at `/workspace` and writable by UID 1000.

## Configuration files

Copy the examples and keep the real files private:

```bash
cp .env.multiuser.example .env.multiuser
cp config/multiuser.example.json config/multiuser.json
```

`config/multiuser.json`:

```json
{
  "version": 1,
  "defaults": { "heapMb": 256 },
  "users": [
    { "name": "alice", "authUser": "alice", "internalPort": 3080 },
    { "name": "bob", "authUser": "bob", "internalPort": 3081 }
  ]
}
```

- `name` is a safe directory label and is unique.
- `authUser` is the exact Authelia `Remote-User` value; it defaults to `name`.
- `internalPort` is the loopback port inside the container; defaults to
  `3080 + index`; 8080 and 8081 are reserved for the gateway/health listener.
- `heapMb` caps the V8 heap of that child; 128–2048.
- `allowedGroups` optionally restricts the user to Authelia groups.

`.env.multiuser` is the deployment-wide source of truth:

| Variable | Meaning |
| --- | --- |
| `DSH_IMAGE_REPOSITORY` / `DSH_IMAGE_VERSION` | Pinned image |
| `DSH_MULTIUSER_PUBLIC_SCHEME` / `HOST` / `PORT` | Public URL, gateway Host fence, and Traefik rule source |
| `DSH_MULTIUSER_PROXY_SECRET` | 32+ random characters shared with Traefik |
| `DSH_MULTIUSER_PROXY_HEADER` | Default `X-DSH-Proxy-Secret` |
| `DSH_MULTIUSER_AUTH_HEADER` | Default `Remote-User` |
| `DSH_MULTIUSER_GROUPS_HEADER` | Default `Remote-Groups` |
| `DSH_MULTIUSER_CONFIG_HOST` | Host path mounted as `/etc/dsh-multiuser/users.json` |
| `DSH_MULTIUSER_USERS_VOLUME` | Named volume or absolute host path mounted at `/workspace` |
| `DSH_MULTIUSER_WORKSPACE_POLICY` | `restricted` (default) or `open` |
| `DSH_MULTIUSER_WORKSPACE_PICKER` | `1` (default) or `0` to hide the picker |
| `DSH_MULTIUSER_WORKSPACE_POLICY_LOCK_DEFAULT` | `1` prevents default rename/delete |
| `DSH_MULTIUSER_WORKSPACE_POLICY_LOCK_ORDER` | `1` prevents moving the default |
| `DSH_MULTIUSER_MEMORY` / `CPUS` / `PIDS_LIMIT` | Container limits |
| `DSH_MULTIUSER_LISTEN_INTERFACE` | Only needed if the container has several interfaces |

Changing the public host in `.env.multiuser` changes the DSH public URL, the
gateway Host check, and the Compose/Traefik rule. Use the same value in the
Authelia access rule.

## Traefik and Authelia

The Compose file joins the external `TRAEFIK_NETWORK` and includes router,
TLS, Authelia and secret-header labels. The labels are convenient with
Traefik's Docker provider. If you use a file provider, adapt
`config/traefik.multiuser.example.yaml` instead.

Required behavior:

1. The router matches exactly the configured public host.
2. `passHostHeader` remains enabled.
3. Authelia forward-auth returns `Remote-User` (and optionally
   `Remote-Groups`) through `authResponseHeaders`.
4. A header middleware adds `X-DSH-Proxy-Secret` after forward-auth.
5. Authelia's access-control rule allows the intended group or users on that
   domain; the default policy should deny everything else.
6. The Authelia session cookie stays on the auth host, not the parent domain,
   so it is not sent to the DSH host.

`config/authelia.multiuser.example.yml` contains a minimal access-control
snippet. The gateway is a second gate: an authenticated user who is not in
`config/multiuser.json` receives 403 even if Authelia allowed the request.

## Workspace layout and policy

```text
/workspace/<user>/
  .dsh/                                         # DSH_HOME
  workspaces/                                   # writable sibling workspaces
  documents/deepseek-harness/default-workspace/ # per-user default workspace
  tmp/ .cache/ .config/ .local/
```

The default workspace is **writable and directly editable**. The policy is
about workspace registration, not file content:

- `@codeorbita/dsh-workspace-policy` replaces `WorkspaceRegistry`;
- creation is allowed under the default workspace and
  `/workspace/<user>/workspaces` only;
- symlink escapes and other users' roots are rejected;
- the default workspace cannot be renamed, deleted, or reordered;
- sub-workspaces can be created, renamed, deleted, and reordered.

`@codeorbita/dsh-directory-picker-policy` wraps the official browse capability:

- the picker is rooted at `/workspace/<user>`;
- internal entries (`.dsh`, caches, `tmp`) are hidden;
- breadcrumbs never go above the user root;
- directory creation is limited to the default workspace and
  `/workspace/<user>/workspaces`;
- the official browse client UI stays unchanged.

Set `DSH_MULTIUSER_WORKSPACE_PICKER=0` to disable the picker (and the Add
workspace UI). The workspace policy still rejects direct API calls outside the
allowed roots.

The policy is enforced by trusted in-process code. A user with shell access can
still create arbitrary directories on the filesystem; the policy prevents them
from registering those directories as DSH Workspaces.

## Start, stop, and inspect

```bash
make multiuser-up
make multiuser-logs
make multiuser-down
```

Equivalent direct command:

```bash
docker compose --env-file .env.multiuser -f compose.multiuser.yaml up -d --no-build
```

`make multiuser-smoke` starts a temporary one-container, two-user deployment,
simulates Traefik's headers, verifies the same-URL login, per-user cookies,
picker/workspace policies, no desktop, token redaction, and restart persistence.

## Operations

### Add or remove a user

1. Add or remove the user in Authelia (and the relevant group).
2. Add or remove the entry in `config/multiuser.json`; keep `authUser` unique.
3. Recreate the container so the supervisor re-reads the config:

   ```bash
   make multiuser-up
   ```

   Removing a user removes their process and route mapping; their directory
   remains on the users volume until you delete it explicitly.

### Back up and restore

Back up the complete users volume, or each `/workspace/<user>` directory. It
contains sessions, settings, provider credentials and workspaces. Restore only
to a stopped container. The DSH 0.2.3 upgrade may migrate persisted state; back
up before the first start of a new DSH version and keep the old volume copy for
downgrade.

### Upgrade

Change `DSH_IMAGE_VERSION` in `.env.multiuser`, then `make multiuser-up`. All
children restart; existing DSH cookies remain valid because the per-user cookie
secret is in `.dsh`. The launch token rotates automatically. Read the DSH
upgrade notes before moving across a major prerelease.

### Resource sizing

Every configured user is a Node process even when idle. There is no per-user
cgroup or disk quota; the container's memory/CPU limits are shared. Start with
`heapMb: 256` per user and measure with `docker stats`; disable the picker or
reduce the number of users if the host is tight. Desktop, Browser Use and noVNC
are disabled in this mode.

## ACL feasibility

POSIX ACLs are keyed by UID/GID. With every child running as UID 1000, every
process is the owner of every file it creates; owner permissions apply to all
users, and a named-user ACL for 1000 cannot distinguish them. ACLs therefore do
not provide per-user workspace isolation in this design.

Real ACL/ownership isolation requires a distinct UID per user (or separate
containers). That means starting the container as root or retaining
`CAP_SETUID`/`CAP_SETGID`/`CAP_CHOWN`, plus host ownership and backup work; it
is intentionally outside this mode. If you need that boundary, use per-user
containers or add a dedicated per-user-UID variant.

## Troubleshooting

- **401 on the public URL** — the gateway received no valid `Remote-User`, or
  the DSH cookie is for another user. Confirm Authelia forward-auth and
  `authResponseHeaders`.
- **403** — missing/wrong proxy secret, unknown user, or missing group. Check
  the Traefik secret-header middleware, `config/multiuser.json`, and
  `allowedGroups`.
- **421** — the request `Host` does not match `DSH_MULTIUSER_PUBLIC_HOST`.
- **503** — a child is still starting or its token was not captured. Check
  `make multiuser-logs`; do not add a token manually.
- **502** — the child is down or the loopback port is unreachable; inspect the
  user's log lines and restart the container.
- **Picker shows the wrong tree** — the picker policy is active per child;
  confirm `directory-picker-policy active` in the logs and the user's
  `DSH_PICKER_ROOT`.
- **Workspace create rejected** — inspect the error; the requested path must be
  under the user's default workspace or `workspaces` directory. Direct API
  calls are rejected too, not only the picker.
- **Logs contain no token** — this is intentional. The supervisor captures and
  redacts launch tokens; the gateway brokers them internally.

## Limits

- Trusted users only; same UID/container; no hard file isolation.
- The default workspace is editable by design.
- No desktop/Browser Use/noVNC.
- No per-user cgroups/disk quotas; no lazy start.
- No external DSH `/connect` API clients; the browser Web UI is the supported
  surface.
- Traefik/Authelia are external prerequisites, not managed by this Compose file.
