# `@codeorbita/dsh-directory-picker-policy`

Host-only DeepSeek Harness plugin that wraps the existing directory-picker browse capability for trusted multi-user deployments.

It:

- roots the in-app picker at `/workspace/<user>`;
- hides internal entries such as `.dsh`, caches, and `tmp`;
- prevents breadcrumbs or listings above the user's root;
- allows directory creation only inside the default workspace and configured sub-workspace roots;
- rejects symlink escapes without changing the official browse client UI.

It is a UX fence. The `@codeorbita/dsh-workspace-policy` plugin remains the authoritative server-side guard for direct `workspace.create` calls.

## Configuration

| Variable | Meaning |
| --- | --- |
| `DSH_DIRECTORY_PICKER_MODULE_URL` | `file:` URL of the installed `@deepseek-ai/dsh-host-directory-picker/lib/index.js` |
| `DSH_PICKER_ROOT` | Absolute user root shown by the picker |
| `DSH_PICKER_HOME` | Initial/home directory, inside the root |
| `DSH_PICKER_ALLOWED_CREATE_ROOTS` | JSON array of absolute roots where new directories may be created |
| `DSH_MULTIUSER_PICKER_HIDDEN` | JSON array of single-segment names to hide |

The multiuser supervisor sets all of these per child. If the host resolves the native OS chooser instead of the browse backend, the wrapper passes the native capability through unchanged.
