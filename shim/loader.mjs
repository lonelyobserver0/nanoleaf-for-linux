// Entry point of the Linux build. Installs the koffi shim, then hands over to
// the unmodified Nanoleaf Desktop main bundle.

import Module, { createRequire } from 'node:module'
import path from 'node:path'
import { systemPreferences } from 'electron'

const require = createRequire(import.meta.url)
const shim = require('./koffi-shim.cjs')

// The bundled koffi wrapper locates koffi.node under resources/koffi/<os>_<arch>
// and require()s it; answer that require with the shim instead.
const loadNative = Module._extensions['.node']
Module._extensions['.node'] = function (module, filename) {
  if (path.basename(filename) === 'koffi.node') {
    module.exports = shim
    return
  }
  return loadNative.call(this, module, filename)
}

// Screen Mirror asks for the screen-recording permission, an API that exists
// only on macOS and Windows. On Linux the portal asks the user when capture
// starts, so report it as granted here.
if (typeof systemPreferences.getMediaAccessStatus !== 'function') {
  systemPreferences.getMediaAccessStatus = () => 'granted'
}

// The built-in updater would fetch the Windows installer (and electron-updater
// only works from an AppImage on Linux anyway), so the splash screen would wait
// forever. Updates come from rebuilding against a newer installer instead.
if (!process.argv.includes('--skip-update')) process.argv.push('--skip-update')
if (process.env.NANOLEAF_SHIM_DEBUG && !process.argv.includes('--log-to-stdout')) {
  process.argv.push('--log-to-stdout')
}

await import('../minified/main.js')
