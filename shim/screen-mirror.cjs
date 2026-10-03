'use strict'

// Linux implementation of libScreenMirror.dll, the "legacy" Screen Mirror
// backend the app falls back to when its newer native addon is missing (always
// the case on Linux). Same contract as the DLL: the app pushes a config, starts
// the mirror with a callback, and on every callback pulls a stream-frame JSON.

const colours = require('./mirror-colors.cjs')

const state = {
  config: null,
  mode: '4D',
  dataCb: null,
  logCb: null,
  active: false,
  frameJson: '',
  palette: [],
  paletteAt: 0,
  modeState: colours.createState(),
  capture: null
}

function log (msg) {
  const line = `[Screen Mirror] [Linux] ${msg}`
  if (state.logCb && typeof state.logCb.fn === 'function') state.logCb.fn(line)
  else console.log(line)
}

function writeCString (buf, str) {
  if (!buf) return -1
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  const bytes = Buffer.from(str, 'utf8')
  if (bytes.length >= b.length) return -1
  bytes.copy(b)
  b[bytes.length] = 0
  return 0
}

// Loaded lazily: requires Electron's main process.
function capture () {
  if (!state.capture) {
    const { ScreenCapture } = require('./screen-capture.cjs')
    state.capture = new ScreenCapture({ onFrame, log })
  }
  return state.capture
}

function fps () {
  // Palette-only runs (Orchestrator starts the mirror with no devices).
  if (!state.config?.devices?.length) return 2
  return colours.TIMING[state.mode].fps
}

function onFrame (img) {
  if (!state.active) return
  const now = Date.now()
  if (now - state.paletteAt > 1000) {
    state.palette = colours.palette(img)
    state.paletteAt = now
  }
  const devices = state.config?.devices ?? []
  if (!devices.length || !state.dataCb) return
  const frames = devices.map((device) => ({
    device,
    frames: colours.framesFor(state.mode, img, device, state.modeState, now)
  }))
  state.frameJson = colours.streamFrameJson(frames)
  try {
    state.dataCb.fn()
  } catch (err) {
    log(`data callback failed: ${err.message}`)
  }
}

const api = {
  getDisplays (buf) {
    let list = []
    try {
      list = require('./screen-capture.cjs').displays()
    } catch (err) {
      log(`cannot list displays: ${err.message}`)
    }
    return writeCString(buf, JSON.stringify({ displays: list }))
  },

  setMirrorConfig (json) {
    try {
      state.config = JSON.parse(json)
    } catch {
      return -1
    }
    state.mode = colours.modeName(state.config.mode)
    state.modeState = colours.createState()
    log(`config: mode ${state.mode}, ${state.config.devices?.length ?? 0} device(s), display #${state.config.displayID}`)
    for (const d of state.config.devices ?? []) {
      if (colours.normalisePanels(d).some((p) => p.fallback)) {
        log(`device ${d.id ?? d.ip} has no valid layout position (NaN); panels spread left to right. ` +
          'Use Reset on the Screen Mirror page to rebuild the layout.')
      }
    }
    if (state.active) capture().setFps(fps())
    return 0
  },

  startMirror (cb) {
    if (!state.config) return -1
    state.dataCb = cb
    state.active = true
    capture().start(Number(state.config.displayID) || 0, fps()).catch((err) => {
      log(`cannot start capture: ${err.message}`)
      state.active = false
    })
    return 0
  },

  stopMirror () {
    state.active = false
    state.frameJson = ''
    state.capture?.stop()
    return 0
  },

  getSizeOfStreamFrameJson () {
    return state.frameJson ? Buffer.byteLength(state.frameJson) + 1 : 0
  },

  getStreamFrameJson (buf) {
    return writeCString(buf, state.frameJson)
  },

  getPalette (buf) {
    const palette = state.palette.map(([R, G, B]) => ({ R, G, B }))
    return writeCString(buf, JSON.stringify({ palette }))
  },

  isActive () {
    return state.active ? 1 : 0
  },

  setExtLogCallback (cb) {
    state.logCb = cb
  }
}

module.exports = { api, state, _onFrame: onFrame }
