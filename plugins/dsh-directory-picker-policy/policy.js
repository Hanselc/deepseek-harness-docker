/**
 * Pure policy helpers for the restricted browse capability.
 *
 * The plugin wraps the existing directory-picker browse capability; these
 * helpers keep the root fence, listing projection, and creation checks
 * independently testable.
 */

import { realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Whether `target` is the same path as, or below, `root`.
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
export function isPathWithin(root, target) {
  if (!isAbsolute(root) || !isAbsolute(target)) return false
  const base = resolve(root)
  const candidate = resolve(target)
  const rel = relative(base, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function requireAbsolute(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`)
  }
  return resolve(value)
}

function parseJsonArray(raw, name) {
  if (raw === undefined || raw === '') return []
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${name} must be a JSON array: ${error.message}`)
  }
  if (!Array.isArray(parsed)) throw new Error(`${name} must be a JSON array`)
  return parsed
}

/**
 * Read the picker policy from environment variables.
 * @param {NodeJS.ProcessEnv} env
 */
export function resolvePickerPolicy(env = process.env) {
  const root = requireAbsolute(env.DSH_PICKER_ROOT, 'DSH_PICKER_ROOT')
  const home = env.DSH_PICKER_HOME === undefined || env.DSH_PICKER_HOME === ''
    ? root
    : requireAbsolute(env.DSH_PICKER_HOME, 'DSH_PICKER_HOME')
  if (!isPathWithin(root, home)) {
    throw new Error('DSH_PICKER_HOME must be inside DSH_PICKER_ROOT')
  }

  const allowedCreateRoots = parseJsonArray(env.DSH_PICKER_ALLOWED_CREATE_ROOTS, 'DSH_PICKER_ALLOWED_CREATE_ROOTS')
    .map(value => requireAbsolute(value, 'DSH_PICKER_ALLOWED_CREATE_ROOTS entry'))
  if (allowedCreateRoots.length === 0) allowedCreateRoots.push(root)
  for (const allowed of allowedCreateRoots) {
    if (!isPathWithin(root, allowed)) {
      throw new Error(`allowed create root ${allowed} must be inside ${root}`)
    }
  }

  const hidden = new Set(parseJsonArray(env.DSH_MULTIUSER_PICKER_HIDDEN, 'DSH_MULTIUSER_PICKER_HIDDEN'))
  for (const name of hidden) {
    if (typeof name !== 'string' || name === '' || name.includes('/') || name.includes('\\')) {
      throw new Error('DSH_MULTIUSER_PICKER_HIDDEN entries must be single path segments')
    }
  }

  return { root, home, allowedCreateRoots, hidden }
}

/**
 * Clamp a requested path to the user's picker root.
 * @param {{root: string, home: string}} policy
 * @param {string | undefined} requested
 * @returns {string}
 */
export function clampPath(policy, requested) {
  const target = requested === undefined || requested === '' ? policy.home : resolve(requested)
  return isPathWithin(policy.root, target) ? target : policy.home
}

/**
 * Build a root-to-target breadcrumb chain; no crumb above the user root.
 * @param {string} root
 * @param {string} target
 * @returns {{name: string, path: string, hidden: boolean}[]}
 */
export function crumbsFor(root, target) {
  const base = resolve(root)
  const path = resolve(target)
  if (!isPathWithin(base, path)) return [{ name: base, path: base, hidden: false }]
  const rel = relative(base, path)
  const chain = [base]
  if (rel !== '') {
    for (const segment of rel.split(sep)) chain.push(join(chain[chain.length - 1], segment))
  }
  return chain.map((entry, index) => ({
    name: index === 0 ? entry : basename(entry),
    path: entry,
    hidden: false,
  }))
}

/**
 * Filter one listing to the user's tree and hide internal state directories.
 * @param {{root: string, home: string, hidden: Set<string>}} policy
 * @param {object} listing
 */
export function filterListing(policy, listing) {
  const entries = listing.entries.filter(entry =>
    !policy.hidden.has(entry.name) && isPathWithin(policy.root, entry.path))
  return {
    ...listing,
    home: policy.home,
    crumbs: crumbsFor(policy.root, listing.path),
    entries,
  }
}

/**
 * Wrap one browse capability with the user's root fence.
 * @param {object} inner browse capability
 * @param {object} policy
 * @param {new (code: string, path: string, message: string) => Error} DirectoryPickerError
 */
export function wrapBrowseCapability(inner, policy, DirectoryPickerError) {
  return {
    kind: 'browse',
    async list(path, signal) {
      let target = clampPath(policy, path)
      try {
        const canonical = await realpath(target)
        if (!isPathWithin(policy.root, canonical)) target = policy.home
      } catch {
        // A missing path is reported by the inner backend with its typed error.
      }
      const listing = await inner.list(target, signal)
      return filterListing(policy, listing)
    },
    async createDirectory(path, name) {
      if (!isAbsolute(path)) {
        throw new DirectoryPickerError('directory-create-failed', String(path), `cannot create under "${path}": not fully qualified`)
      }
      const parent = resolve(path)
      if (!isPathWithin(policy.root, parent)) {
        throw new DirectoryPickerError('directory-create-failed', parent, `directory creation is restricted to ${policy.root}`)
      }
      let canonicalParent
      try {
        canonicalParent = await realpath(parent)
      } catch {
        throw new DirectoryPickerError('directory-create-failed', parent, `cannot create under "${parent}": directory is unavailable`)
      }
      if (!isPathWithin(policy.root, canonicalParent)) {
        throw new DirectoryPickerError('directory-create-failed', parent, `directory creation is restricted to ${policy.root}`)
      }
      if (!policy.allowedCreateRoots.some(root => isPathWithin(root, canonicalParent))) {
        throw new DirectoryPickerError('directory-create-failed', parent, 'directory creation is restricted to the default workspace and configured sub-workspace roots')
      }
      return await inner.createDirectory(canonicalParent, name)
    },
  }
}
