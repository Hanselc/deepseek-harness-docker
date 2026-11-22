/**
 * Restricted directory-picker browse capability.
 *
 * Loaded after the regular directory-picker backend; wraps the service
 * capability so the in-app browser cannot leave the user's root or create
 * directories outside the default workspace/sub-workspace roots.
 */

import { resolvePickerPolicy, wrapBrowseCapability } from './policy.js'

const moduleUrl = process.env.DSH_DIRECTORY_PICKER_MODULE_URL
if (typeof moduleUrl !== 'string' || moduleUrl === '') {
  throw new Error('DSH_DIRECTORY_PICKER_MODULE_URL is required to load @codeorbita/dsh-directory-picker-policy')
}
const { DirectoryPickerError } = await import(moduleUrl)

export const name = 'directory-picker-policy'
export const inject = ['directoryPicker']

export function apply(ctx) {
  const policy = resolvePickerPolicy(process.env)
  const picker = ctx.directoryPicker
  const original = picker.capability.bind(picker)
  const inner = original()
  if (inner.kind !== 'browse') return

  const wrapped = wrapBrowseCapability(inner, policy, DirectoryPickerError)
  const previous = Object.getOwnPropertyDescriptor(picker, 'capability')
  Object.defineProperty(picker, 'capability', {
    configurable: true,
    writable: true,
    value: () => wrapped,
  })
  ctx.effect(() => () => {
    if (previous !== undefined) Object.defineProperty(picker, 'capability', previous)
    else delete picker.capability
  })
  console.log(`directory-picker-policy active: root=${policy.root} home=${policy.home}`)
}
