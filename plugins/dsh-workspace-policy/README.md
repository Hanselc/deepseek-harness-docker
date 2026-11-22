# `@codeorbita/dsh-workspace-policy`

Host-only DeepSeek Harness plugin for trusted multi-user deployments.

It replaces the default `WorkspaceRegistry` and:

- keeps the configured default workspace writable;
- allows creating sub-workspaces under that default workspace or the configured writable roots;
- rejects arbitrary workspace paths, symlink escapes, and other users' roots;
- rejects renaming, deleting, or moving the default workspace registration;
- leaves normal sub-workspace rename/delete/reorder available.

It does **not** make workspace files read-only and does **not** provide OS-level isolation. Run it only for trusted users; use per-user UIDs or containers when file-level isolation is required.

## Configuration

The plugin is loaded by the multiuser Cordis patch and reads:

| Variable | Meaning |
| --- | --- |
| `DSH_WORKSPACE_MODULE_URL` | `file:` URL of the installed `@deepseek-ai/dsh-workspace/lib/index.js` |
| `DSH_WORKSPACE_POLICY` | `restricted` (default) or `open` |
| `DSH_WORKSPACE_POLICY_DEFAULT` | Absolute per-user default workspace path |
| `DSH_WORKSPACE_POLICY_ALLOWED_ROOTS` | JSON array of absolute roots allowed for workspace creation |
| `DSH_WORKSPACE_POLICY_LOCK_DEFAULT` | `0` disables default rename/delete lock |
| `DSH_WORKSPACE_POLICY_LOCK_ORDER` | `0` disables default order lock |

The multiuser supervisor sets all of these per child.

## Limitations

- The policy is enforced by trusted in-process code, not a kernel boundary.
- The default workspace's files are editable by design.
- A shell-capable user can still read other users' files in the shared container. See `docs/multiuser.md`.
