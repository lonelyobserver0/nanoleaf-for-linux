'use strict'
// Runs the Linux libScreenMirror implementation against a synthetic screen:
// node test/screen-mirror.cjs
const assert = require('node:assert')
const sm = require('../shim/screen-mirror.cjs')
const colours = require('../shim/mirror-colors.cjs')

// 96x54 "screen": left half red, right half blue, bottom-right quadrant green.
const W = 96, H = 54
const data = new Uint8ClampedArray(W * H * 4)
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 4
  const c = x < W / 2 ? [220, 20, 20] : (y >= H / 2 ? [20, 200, 20] : [20, 20, 220])
  data.set([...c, 255], i)
}
const img = { width: W, height: H, data }

// Fake capture: no Electron needed.
sm.state.capture = { start: async () => {}, stop () {}, setFps () {} }

// Layout y is up: panel 3 (y=0) is at the bottom of the screen.
const device = {
  ip: '192.168.1.28', controlVersion: 1,
  panels: [
    { panelID: 1, centroidX: 0, centroidY: 100 },   // top-left     -> red
    { panelID: 2, centroidX: 100, centroidY: 100 }, // top-right    -> blue
    { panelID: 3, centroidX: 100, centroidY: 0 },   // bottom-right -> green
    { panelID: 4, centroidX: 0, centroidY: 0 }      // bottom-left  -> red
  ]
}

const parse = () => {
  const buf = Buffer.alloc(sm.api.getSizeOfStreamFrameJson())
  assert.strictEqual(sm.api.getStreamFrameJson(buf), 0)
  return JSON.parse(buf.toString().replace(/\0.*$/s, ''))
}
const dominant = ([r, g, b]) => ['r', 'g', 'b'][[r, g, b].indexOf(Math.max(r, g, b))]

let calls = 0
assert.strictEqual(sm.api.setMirrorConfig(JSON.stringify({ displayID: 0, mode: 0, devices: [device] })), 0)
assert.strictEqual(sm.api.startMirror({ fn: () => calls++ }), 0)
assert.strictEqual(sm.api.isActive(), 1)
sm._onFrame(img)
assert.strictEqual(calls, 1)

// Same parsing the app does (axe in main.js).
const json = parse()
const o = json.devices[0].animData.split(' ').map(Number)
assert.strictEqual(o[0], 4)
const panels = {}
for (let s = 1; s < o.length; s += 7) panels[o[s]] = [o[s + 2], o[s + 3], o[s + 4]]
console.log('4D', panels)
assert.deepStrictEqual(Object.fromEntries(Object.entries(panels).map(([k, v]) => [k, dominant(v)])),
  { 1: 'r', 2: 'b', 3: 'g', 4: 'r' })

for (const mode of [1, 2, 3]) {
  sm.api.setMirrorConfig(JSON.stringify({ displayID: 0, mode, devices: [device] }))
  sm._onFrame(img); sm._onFrame(img)
  console.log(colours.MODES[mode], parse().devices[0].animData)
}

const pbuf = Buffer.alloc(512)
sm.api.getPalette(pbuf)
const palette = JSON.parse(pbuf.toString().replace(/\0.*$/s, '')).palette
console.log('palette', palette)
assert.ok(palette.length >= 3)

// Broken layout from the app (NaN centroids): still mirrors, left to right.
const broken = { ...device, panels: device.panels.map((p) => ({ ...p, centroidX: NaN, centroidY: NaN })) }
sm.api.setMirrorConfig(JSON.stringify({ displayID: 0, mode: 0, devices: [broken] }))
sm._onFrame(img)
const ob = parse().devices[0].animData.split(' ').map(Number)
console.log('NaN layout 4D', parse().devices[0].animData)
assert.ok(ob.every(Number.isFinite))
assert.strictEqual(dominant([ob[3], ob[4], ob[5]]), 'r') // first panel: left edge
assert.notStrictEqual(dominant([ob[ob.length - 5], ob[ob.length - 4], ob[ob.length - 3]]), 'r') // last: right side

sm.api.stopMirror()
assert.strictEqual(sm.api.isActive(), 0)
assert.strictEqual(sm.api.getSizeOfStreamFrameJson(), 0)
console.log('ALL OK')
