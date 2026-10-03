'use strict'

// Turns a downscaled screen capture into per-panel colours for the four
// Screen Mirror modes. Pure functions over { width, height, data: RGBA }, so
// they can be tested without a screen.

const MODES = ['4D', 'Tranquility', 'Flow', 'Chameleon']

// Update rate (frames/s) and panel transition time (1/10 s) per mode.
const TIMING = {
  '4D': { fps: 12, transTime: 1 },
  Tranquility: { fps: 2, transTime: 10 },
  Flow: { fps: 6, transTime: 2 },
  Chameleon: { fps: 1, transTime: 20 }
}

const PALETTE_SIZE = 5

function modeName (mode) {
  return typeof mode === 'number' ? (MODES[mode] ?? '4D') : (MODES.includes(mode) ? mode : '4D')
}

function regionAverage (img, x0, y0, x1, y1) {
  const xa = Math.max(0, Math.floor(x0)), xb = Math.min(img.width, Math.ceil(x1))
  const ya = Math.max(0, Math.floor(y0)), yb = Math.min(img.height, Math.ceil(y1))
  let r = 0, g = 0, b = 0, n = 0
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const i = (y * img.width + x) * 4
      r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++
    }
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0]
}

// Screen averages come out greyish; push saturation a little so the panels
// show the hue rather than a washed-out mix. Near-black stays black.
function enhance ([r, g, b]) {
  const max = Math.max(r, g, b)
  if (max < 10) return [0, 0, 0]
  const mean = (r + g + b) / 3
  const boosted = [r, g, b].map((c) => mean + (c - mean) * 1.3)
  // Rescale so the brightest channel keeps its original level.
  const scale = max / Math.max(...boosted)
  return boosted.map((c) => Math.round(Math.min(255, Math.max(0, c * scale))))
}

// Panel centroids normalised to [0, 1]². Nanoleaf layouts use y-up, screens y-down.
function normalisePanels (device) {
  const panels = device.panels ?? []
  if (!panels.length) return []
  // The app can hand over NaN centroids when its saved Screen Mirror layout is
  // broken (it divides by an unrendered element's size). Spread the panels
  // across the screen instead of mirroring nothing.
  if (!panels.every((p) => Number.isFinite(p.centroidX) && Number.isFinite(p.centroidY))) {
    return panels.map((p, i) => ({ id: p.panelID, u: panels.length > 1 ? i / (panels.length - 1) : 0.5, v: 0.5, fallback: true }))
  }
  const xs = panels.map((p) => p.centroidX), ys = panels.map((p) => p.centroidY)
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  const w = maxX - minX, h = maxY - minY
  return panels.map((p) => ({
    id: p.panelID,
    u: w ? (p.centroidX - minX) / w : 0.5,
    v: h ? 1 - (p.centroidY - minY) / h : 0.5
  }))
}


// Small k-means over the pixels; returns the clusters sorted by size.
function palette (img, k = PALETTE_SIZE) {
  const px = []
  const step = Math.max(1, Math.floor((img.width * img.height) / 2000))
  for (let i = 0; i < img.width * img.height; i += step) {
    const o = i * 4
    const c = [img.data[o], img.data[o + 1], img.data[o + 2]]
    if (Math.max(...c) > 15) px.push(c) // ignore black bars
  }
  if (!px.length) return []
  const dist = (a, m) => (a[0] - m[0]) ** 2 + (a[1] - m[1]) ** 2 + (a[2] - m[2]) ** 2
  // Farthest-point seeding: deterministic, and distinct colours get their own
  // cluster instead of being averaged together.
  let centres = [px[Math.floor(px.length / 2)].slice()]
  while (centres.length < Math.min(k, px.length)) {
    let far = null, farD = -1
    for (const c of px) {
      const d = Math.min(...centres.map((m) => dist(c, m)))
      if (d > farD) { farD = d; far = c }
    }
    if (farD <= 0) break
    centres.push(far.slice())
  }
  let counts = []
  for (let iter = 0; iter < 8; iter++) {
    const sums = centres.map(() => [0, 0, 0]); counts = centres.map(() => 0)
    for (const c of px) {
      let best = 0, bestD = Infinity
      centres.forEach((m, j) => {
        const d = dist(c, m)
        if (d < bestD) { bestD = d; best = j }
      })
      sums[best][0] += c[0]; sums[best][1] += c[1]; sums[best][2] += c[2]; counts[best]++
    }
    centres = centres.map((m, j) => counts[j] ? sums[j].map((s) => s / counts[j]) : m)
  }
  return centres
    .map((c, j) => ({ c: enhance(c), n: counts[j] }))
    .filter((e) => e.n > 0)
    .sort((a, b) => b.n - a.n)
    .map((e) => e.c)
}

// The biggest colour cluster: a plain average of a varied screen is mud.
function dominantColour (img) {
  return palette(img, 3)[0] ?? [0, 0, 0]
}

// Per-device mutable state for the modes that evolve over time.
function createState () {
  return { flow: new Map(), tranquil: new Map(), chameleonPhase: 0, chameleonAt: 0 }
}

function framesFor (mode, img, device, state, now = Date.now()) {
  const panels = normalisePanels(device)
  const { transTime } = TIMING[mode]
  const colourOf = (rgb, id) => ({ panelId: id, r: rgb[0], g: rgb[1], b: rgb[2], transTime })

  switch (mode) {
    case 'Tranquility': {
      // One calm colour for the whole device, smoothed over time.
      const target = dominantColour(img)
      const prev = state.tranquil.get(device.ip) ?? target
      const mixed = prev.map((c, i) => Math.round(c * 0.6 + target[i] * 0.4))
      state.tranquil.set(device.ip, mixed)
      return panels.map((p) => colourOf(mixed, p.id))
    }
    case 'Flow': {
      // The screen colour enters on the left and travels across the panels.
      const order = [...panels].sort((a, b) => a.u - b.u || a.v - b.v)
      const hist = state.flow.get(device.ip) ?? []
      hist.unshift(dominantColour(img))
      hist.length = Math.min(hist.length, order.length)
      state.flow.set(device.ip, hist)
      return order.map((p, i) => colourOf(hist[Math.min(i, hist.length - 1)], p.id))
    }
    case 'Chameleon': {
      const pal = palette(img)
      if (!pal.length) return panels.map((p) => colourOf([0, 0, 0], p.id))
      if (now - state.chameleonAt > 4000) { state.chameleonPhase++; state.chameleonAt = now }
      return panels.map((p, i) => colourOf(pal[(i + state.chameleonPhase) % pal.length], p.id))
    }
    default: {
      // 4D: every panel mirrors the part of the screen it sits in front of.
      const half = Math.min(0.5, Math.max(0.06, 0.5 / Math.sqrt(Math.max(panels.length, 1))))
      return panels.map((p) => {
        const cx = p.u * img.width, cy = p.v * img.height
        const rx = half * img.width, ry = half * img.height
        return colourOf(enhance(regionAverage(img, cx - rx, cy - ry, cx + rx, cy + ry)), p.id)
      })
    }
  }
}

// The JSON libScreenMirror.dll hands to the app: Nanoleaf streaming "animData"
// ("nPanels  id nFrames r g b w transTime ...") per device.
function streamFrameJson (frames) {
  return JSON.stringify({
    devices: frames.map(({ device, frames: f }) => ({
      ip: device.ip,
      controlVersion: device.controlVersion,
      animData: [f.length, ...f.flatMap((p) => [p.panelId, 1, p.r, p.g, p.b, 0, p.transTime])].join(' ')
    }))
  })
}

module.exports = { MODES, TIMING, modeName, palette, framesFor, streamFrameJson, createState, normalisePanels }
