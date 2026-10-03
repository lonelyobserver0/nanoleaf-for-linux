'use strict'
// Live check of the PipeWire music-sync capture: node test/audio.cjs
// Play something (e.g. a video) while it runs.
const assert = require('node:assert')
const audio = require('../shim/audio.cjs').api

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function capture (sourceId, ms = 2000) {
  let frames = 0, sum = 0, calls = 0
  const status = await new Promise((resolve) => {
    audio.start(sourceId, { fn: resolve }, {
      // Same as the app's AudioDataAvailableCallback.
      fn: () => {
        const n = audio.getFrameLength()
        const L = new Float32Array(n), R = new Float32Array(n)
        const got = audio.getData(L, R, n)
        for (let i = 0; i < got; i++) sum += L[i] * L[i] + R[i] * R[i]
        frames += got; calls++
      }
    })
  })
  assert.strictEqual(status, 0)
  await wait(ms)
  await new Promise((resolve) => audio.stop({ fn: resolve }))
  const rms = Math.sqrt(sum / Math.max(1, 2 * frames))
  assert.ok(Number.isFinite(rms), 'non-finite samples (stream misaligned?)')
  assert.ok(rms < 1.5, 'samples out of range (stream misaligned?)')
  console.log(`${sourceId}: ${frames} frames in ${calls} callbacks (${(frames / (ms / 1000)).toFixed(0)}/s), rms ${rms.toFixed(4)}`)
  return { frames, rms }
}

;(async () => {
  audio.setLogCallback({ fn: (m) => console.log(m) })
  const sources = await new Promise((resolve) => audio.getAvailableContent({ fn: (s, json) => resolve(JSON.parse(json)) }))
  console.log('sources', sources.applications)
  assert.strictEqual(sources.applications[0].bundleIdentifier, 'system')
  assert.strictEqual(audio.getSampleRate(), 48000)

  const sys = await capture('system')
  assert.ok(sys.frames > 48000 * 1.5, 'system capture delivered too few frames')
  for (const app of sources.applications.slice(1)) await capture(app.bundleIdentifier, 2500)
  // An app that is not playing yields no audio until it starts (no fallback).
  const idle = await capture('app:not-running', 1000)
  assert.strictEqual(idle.frames, 0)
  console.log('ALL OK')
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
