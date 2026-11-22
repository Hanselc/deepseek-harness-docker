/**
 * Trusted multi-user workspace policy.
 *
 * This plugin is loaded instead of `@deepseek-ai/dsh-workspace` through the
 * multiuser Cordis patch. It keeps the default workspace writable while
 * stopping arbitrary workspace registration and default rename/delete/reorder.
 */

import { isAbsolute } from 'node:path'
import {
  assertCreateAllowed,
  canonicalPath,
  isDefaultWorkspace,
  resolvePolicy,
  wrapWorkspace,
} from './policy.js'

const moduleUrl = process.env.DSH_WORKSPACE_MODULE_URL
if (typeof moduleUrl !== 'string' || moduleUrl === '') {
  throw new Error('DSH_WORKSPACE_MODULE_URL is required to load @codeorbita/dsh-workspace-policy')
}
const { default: WorkspaceRegistry } = await import(moduleUrl)

export const name = 'workspace-policy'

/** Durable domain dependencies inherited by the base registry. */
export const inject = ['storageDomain', 'sessionPersistence']

export default class PolicyWorkspaceRegistry extends WorkspaceRegistry {
  static inject = ['storageDomain', 'sessionPersistence']

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   */
  constructor(ctx) {
    super(ctx)
    this.policy = resolvePolicy(process.env)
  }

  wrap(workspace) {
    if (workspace === undefined || this.policy.mode === 'open') return workspace
    if (!this.policy.lockDefault) return workspace
    return isDefaultWorkspace(this.policy, workspace.path)
      ? wrapWorkspace(workspace, { lockTitle: true })
      : workspace
  }

  isDefault(workspace) {
    return workspace !== undefined && isDefaultWorkspace(this.policy, workspace.path)
  }

  /**
   * Create or reuse a workspace only inside the configured roots.
   * @param {string} path
   * @param {string} [title]
   */
  async create(path, title) {
    if (this.policy.mode === 'open') return await super.create(path, title)
    if (!isAbsolute(path)) return await super.create(path, title)
    let canonical
    try {
      canonical = await canonicalPath(path)
    } catch {
      return await super.create(path, title)
    }
    assertCreateAllowed(this.policy, canonical)
    return this.wrap(await super.create(canonical, title))
  }

  /**
   * Initialize the per-user default workspace and wrap it for title locking.
   * @param {() => Promise<string>} resolveDirectory
   */
  async initializeDefault(resolveDirectory) {
    return this.wrap(await super.initializeDefault(resolveDirectory))
  }

  get(id) {
    return this.wrap(super.get(id))
  }

  list() {
    return super.list().map(workspace => this.wrap(workspace))
  }

  async delete(id) {
    const workspace = super.get(id)
    if (this.policy.mode === 'restricted' && this.policy.lockDefault && this.isDefault(workspace)) {
      throw new Error('the default workspace cannot be deleted')
    }
    return await super.delete(id)
  }

  async insertBefore(id, beforeId) {
    const workspace = super.get(id)
    if (this.policy.mode === 'restricted' && this.policy.lockOrder && this.isDefault(workspace)) {
      throw new Error('the default workspace cannot be moved in the workspace order')
    }
    return await super.insertBefore(id, beforeId)
  }
}
