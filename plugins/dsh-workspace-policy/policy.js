/**
 * Pure policy helpers for the trusted multi-user workspace fence.
 *
 * The plugin replaces the WorkspaceRegistry service and applies these helpers
 * before delegation. No DSH import is needed here, so the rules are unit-testable
 * without a running Harness.
 */

import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Whether `target` is the same path as, or below, `root`.
 * Both paths are compared lexically; callers canonicalize first when symlinks
 * matter.
 * @param {string} root absolute root directory
 * @param {string} target absolute candidate
 * @returns {boolean}
 */
export function isPathWithin(root, target) {
  if (!isAbsolute(root) || !isAbsolute(target)) return false
  const base = resolve(root)
  const candidate = resolve(target)
  const rel = relative(base, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Resolve one path through realpath. Callers use this before checking
 * containment so a symlink cannot escape an allowed root.
 * @param {string} path absolute path
 * @returns {Promise<string>}
 */
export async function canonicalPath(path) {
  return await realpath(path)
}

/**
 * Read and validate the deployment policy from environment variables.
 * Fails closed when the restricted mode is missing its roots.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{mode: 'restricted' | 'open', defaultPath: string | undefined, allowedRoots: string[], lockDefault: boolean, lockOrder: boolean}}
 */
export function resolvePolicy(env = process.env) {
  const mode = env.DSH_WORKSPACE_POLICY ?? 'restricted'
  if (mode !== 'restricted' && mode !== 'open') {
    throw new Error(`DSH_WORKSPACE_POLICY must be "restricted" or "open", got ${JSON.stringify(mode)}`)
  }

  const defaultPath = env.DSH_WORKSPACE_POLICY_DEFAULT
  if (mode === 'restricted' && (!defaultPath || !isAbsolute(defaultPath))) {
    throw new Error('DSH_WORKSPACE_POLICY_DEFAULT must be an absolute path in restricted mode')
  }
  if (defaultPath !== undefined && !isAbsolute(defaultPath)) {
    throw new Error('DSH_WORKSPACE_POLICY_DEFAULT must be absolute')
  }

  const rawRoots = env.DSH_WORKSPACE_POLICY_ALLOWED_ROOTS
  let allowedRoots = []
  if (rawRoots !== undefined && rawRoots !== '') {
    let parsed
    try {
      parsed = JSON.parse(rawRoots)
    } catch (error) {
      throw new Error(`DSH_WORKSPACE_POLICY_ALLOWED_ROOTS must be a JSON array: ${error.message}`)
    }
    if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string' || !isAbsolute(value))) {
      throw new Error('DSH_WORKSPACE_POLICY_ALLOWED_ROOTS must contain absolute paths')
    }
    allowedRoots = parsed.map(value => resolve(value))
  }
  if (defaultPath !== undefined) {
    const resolved = resolve(defaultPath)
    if (!allowedRoots.includes(resolved)) allowedRoots.push(resolved)
  }
  if (mode === 'restricted' && allowedRoots.length === 0) {
    throw new Error('restricted workspace policy requires at least one allowed root')
  }

  return {
    mode,
    defaultPath: defaultPath === undefined ? undefined : resolve(defaultPath),
    allowedRoots,
    lockDefault: (env.DSH_WORKSPACE_POLICY_LOCK_DEFAULT ?? '1') !== '0',
    lockOrder: (env.DSH_WORKSPACE_POLICY_LOCK_ORDER ?? '1') !== '0',
  }
}

/**
 * Whether a workspace path is the configured default workspace.
 * @param {{defaultPath?: string}} policy
 * @param {string} path
 * @returns {boolean}
 */
export function isDefaultWorkspace(policy, path) {
  return policy.defaultPath !== undefined && isPathWithin(policy.defaultPath, path)
    && isPathWithin(path, policy.defaultPath)
}

/**
 * Reject workspace creation outside the configured roots.
 * @param {{mode: string, allowedRoots: string[]}} policy
 * @param {string} canonical already-realpath'd candidate
 */
export function assertCreateAllowed(policy, canonical) {
  if (policy.mode === 'open') return
  if (!policy.allowedRoots.some(root => isPathWithin(root, canonical))) {
    throw new Error(
      `workspace creation is restricted to the configured default workspace or its allowed sub-workspaces; `
      + `"${canonical}" is outside ${policy.allowedRoots.join(', ')}`,
    )
  }
}

/**
 * Wrap one Workspace entity so its display title cannot change.
 * The proxy binds every other method to the real entity, preserving private
 * fields in the underlying implementation.
 * @param {object} workspace
 * @param {{lockTitle?: boolean}} [options]
 * @returns {object}
 */
export function wrapWorkspace(workspace, options = {}) {
  if (workspace === undefined || options.lockTitle !== true) return workspace
  return new Proxy(workspace, {
    get(target, property) {
      if (property === 'setTitle') {
        return async () => {
          throw new Error('the default workspace cannot be renamed')
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
