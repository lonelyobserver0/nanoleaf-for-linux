'use strict'
// Smoke test for the Wine bridge: node test/smoke.cjs <dir containing the Nanoleaf DLLs>
const path = require('node:path')
const assert = require('node:assert')

process.env.NANOLEAF_BRIDGE_HELPER ||= path.join(__dirname, '..', 'helper', 'build', 'nlbridge.exe.so')
const koffi = require('../shim/koffi-shim.cjs')
const libDir = process.argv[2]
const lib = (n) => path.join(libDir, `${n}.dylib`) // what the app asks for on non-Windows

;(async () => {
  let t = Date.now()
  const cc = koffi.load(lib('libColorCalibration'))
  console.log(`bridge + load: ${Date.now() - t} ms`)
  const init = cc.func('int ColorCalibration_init()')
  const colour = cc.func('int ColorCalibration_getCalibratedColor(int dType, const int *inRgb, int *outRgb)')
  const cct = cc.func('int ColorCalibration_getCalibratedCCT(int dType, int cct, int *outRgb)')
  assert.strictEqual(init(), 0)
  const out = new Int32Array(3)
  assert.strictEqual(colour(3, new Int32Array([255, 128, 0]), out), 0)
  console.log('calibrated rgb', [...out])
  assert.deepStrictEqual([...out], [255, 135, 0])
  assert.strictEqual(cct(3, 2700, out), 0)
  console.log('calibrated 2700K', [...out])

  t = process.hrtime.bigint()
  for (let i = 0; i < 1000; i++) colour(3, [i % 256, 10, 20], out)
  console.log(`1000 sync calls: ${Number(process.hrtime.bigint() - t) / 1e6} ms`)

  const mp = koffi.load(lib('libMotionPlayer'))
  const len = mp.func('int MotionPlayer_getMotionConfigJsonLength()')()
  const buf = Buffer.alloc(len + 1)
  mp.func('void MotionPlayer_getMotionConfigJson(char*)')(buf)
  const json = JSON.parse(buf.toString().replace(/\0.*$/s, ''))
  console.log(`motion config: ${len} bytes, top-level keys:`, Object.keys(json).slice(0, 8))

  // async path
  const asyncLen = await new Promise((res, rej) =>
    mp.func('int MotionPlayer_getMotionConfigJsonLength()').async((e, r) => e ? rej(e) : res(r)))
  assert.strictEqual(asyncLen, len)
  console.log('async call ok')

  // callback path: Shazam signature of 3 s of silence, delivered via callback
  const sz = koffi.load(lib('libShazamSignature'))
  koffi.proto('void ShazamSignatureDoneCallback(int)')
  const sigAsync = sz.func('void getSignatureAsync(const short*, size_t, char*, size_t, ShazamSignatureDoneCallback*)')
  const samples = new Int16Array(16000 * 3)
  const sigBuf = Buffer.alloc(4096)
  const keepAlive = setInterval(() => {}, 1000) // the callback alone does not keep node alive
  const status = await new Promise((res) => {
    const cb = koffi.register((s) => { koffi.unregister(cb); res(s) }, 'ShazamSignatureDoneCallback*')
    sigAsync(samples, samples.length, sigBuf, sigBuf.length, cb)
  })
  clearInterval(keepAlive)
  const signature = sigBuf.toString().replace(/\0.*$/s, '')
  console.log('shazam callback status', status, 'signature:', signature.slice(0, 60))
  assert.strictEqual(status, 0)
  assert.ok(signature.startsWith('data:audio/vnd.shazam.sig;base64,'), 'retained buffer was not synced back')

  // stubbed lib
  const sm = koffi.load(lib('libScreenMirror'))
  const d = Buffer.alloc(512)
  sm.func('int getDisplays(char*, int)')(d, d.length)
  console.log('stub displays', d.toString().replace(/\0.*$/s, ''))
  console.log('ALL OK')
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
