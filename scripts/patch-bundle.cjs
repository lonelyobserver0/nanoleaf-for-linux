'use strict'

// Minimal, targeted edits to the minified main bundle, for gates that can't be
// lifted from outside (everything else is done by the shim at runtime).
// Identifiers are minified and change between releases, so every patch matches
// on stable code shape and must apply exactly once, or the build fails.
//
//   node scripts/patch-bundle.cjs <path to minified/main.js>

const fs = require('node:fs')

const ID = '[A-Za-z_$][\\w$]*'

const PATCHES = [
  {
    name: 'enable audio capture (music sync) on Linux',
    // scn=process.platform==="darwin"&&X.major>=22||process.platform==="win32"&&X.patch>=19045,sv=scn?vr.load(…)
    find: new RegExp(
      `(${ID}=)(process\\.platform==="darwin"&&${ID}\\.major>=22\\|\\|process\\.platform==="win32"&&${ID}\\.patch>=19045)` +
      `(,${ID}=${ID}\\?${ID}\\.load\\()`, 'g'),
    replace: '$1($2||process.platform==="linux")$3'
  }
]

const file = process.argv[2]
if (!file) {
  console.error('usage: patch-bundle.cjs <main.js>')
  process.exit(2)
}
let src = fs.readFileSync(file, 'utf8')
for (const p of PATCHES) {
  const hits = src.match(p.find)?.length ?? 0
  if (hits !== 1) {
    console.error(`patch-bundle: "${p.name}" matched ${hits} times (expected 1); the bundle changed, update the patch`)
    process.exit(1)
  }
  src = src.replace(p.find, p.replace)
  console.log(`    patched: ${p.name}`)
}
fs.writeFileSync(file, src)
