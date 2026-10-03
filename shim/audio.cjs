'use strict'

// Linux implementation of libAudio.dll (music sync: Rhythm streaming and
// Orchestrator). The DLL captures the system output or a single application
// (WASAPI process loopback on Windows); here PipeWire does the same through
// pw-record:
//  - system audio: the default sink's monitor;
//  - one application: pw-record starts unconnected and every output stream of
//    that application is linked to it with pw-link (PipeWire mixes them). Apps
//    like Firefox open several streams and new ones per tab or video, so the
//    links are refreshed every second.
//
// Contract: getAvailableContent(cb) lists sources; start(sourceId, status,
// data) calls status(0) once running and data() whenever samples are ready,
// after which the app pulls them with getFrameLength() + getData(L, R, n).

const { spawn, execFile } = require('node:child_process')

const RATE = 48000
const CHANNELS = 2
const FRAME = 1024 // frames per data callback (~21 ms)
const MAX_BUFFERED = RATE // drop audio older than 1 s if the app falls behind

// Source ids are persisted by the app, so apps are identified by their binary
// (stable) rather than the PipeWire serial (changes every run).
const SYSTEM = 'system'
const APP_PREFIX = 'app:'

const LINK_INTERVAL_MS = 1000

const state = {
  logCb: null,
  child: null,
  linker: null,
  nodeName: null,
  dataCb: null,
  pending: Buffer.alloc(0), // bytes not yet forming a whole frame
  left: new Float32Array(MAX_BUFFERED),
  right: new Float32Array(MAX_BUFFERED),
  buffered: 0
}

function log (msg) {
  const line = `[Audio] [Linux] ${msg}`
  if (state.logCb && typeof state.logCb.fn === 'function') state.logCb.fn(line)
  else console.log(line)
}

function pwDump () {
  return new Promise((resolve, reject) => {
    execFile('pw-dump', { maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
      if (err) return reject(err)
      try { resolve(JSON.parse(out)) } catch (e) { reject(e) }
    })
  })
}

const appBinary = (props) => props['application.process.binary'] || props['application.name']

// Applications currently owning an audio output stream.
async function playingApps () {
  const apps = new Map()
  for (const obj of await pwDump()) {
    const p = obj.info?.props
    if (!p || p['media.class'] !== 'Stream/Output/Audio') continue
    const binary = appBinary(p)
    if (binary && !apps.has(binary)) apps.set(binary, { binary, name: p['application.name'] || binary })
  }
  return [...apps.values()]
}

// Which of our two input channels an application's output port feeds.
function targetChannels (channel) {
  if (/^(FL|RL|SL|AUX0)$/.test(channel)) return ['FL']
  if (/^(FR|RR|SR|AUX1)$/.test(channel)) return ['FR']
  return ['FL', 'FR'] // MONO, FC, LFE, unknown
}

// Links every output port of `binary`'s streams to our capture node.
async function refreshLinks (binary) {
  const objs = await pwDump()
  const ours = objs.find((o) => o.type === 'PipeWire:Interface:Node' && o.info?.props?.['node.name'] === state.nodeName)
  if (!ours) return
  const ports = objs.filter((o) => o.type === 'PipeWire:Interface:Port')
  const inputs = {}
  for (const p of ports) {
    if (p.info?.props?.['node.id'] === ours.id && p.info.direction === 'input') inputs[p.info.props['audio.channel']] = p.id
  }
  const linked = new Set(objs
    .filter((o) => o.type === 'PipeWire:Interface:Link' && o.info?.['input-node-id'] === ours.id)
    .map((l) => `${l.info['output-port-id']}>${l.info['input-port-id']}`))
  const streams = new Set(objs
    .filter((o) => o.info?.props?.['media.class'] === 'Stream/Output/Audio' && appBinary(o.info.props) === binary)
    .map((o) => o.id))

  const wanted = []
  for (const p of ports) {
    if (!streams.has(p.info?.props?.['node.id']) || p.info.direction !== 'output') continue
    for (const ch of targetChannels(p.info.props['audio.channel'])) {
      if (inputs[ch] != null && !linked.has(`${p.id}>${inputs[ch]}`)) wanted.push([p.id, inputs[ch]])
    }
  }
  await Promise.all(wanted.map(([o, i]) => new Promise((resolve) => {
    execFile('pw-link', [String(o), String(i)], (err) => {
      if (err) log(`pw-link ${o} ${i} failed: ${err.message.trim()}`)
      resolve()
    })
  })))
  if (wanted.length) log(`linked ${wanted.length} port(s) of ${binary} (${streams.size} stream(s))`)
  return streams.size
}

function startLinker (binary) {
  let busy = false
  let warned = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const streams = await refreshLinks(binary)
      if (streams === 0 && !warned) { log(`${binary} has no audio stream yet; waiting for it to play`); warned = true }
      if (streams) warned = false
    } catch (err) {
      log(`cannot link ${binary}: ${err.message}`)
    } finally {
      busy = false
    }
  }
  setTimeout(tick, 200) // give pw-record time to create its node
  state.linker = setInterval(tick, LINK_INTERVAL_MS)
}

function emitData () {
  while (state.buffered >= FRAME && state.child) {
    const before = state.buffered
    try {
      state.dataCb?.fn()
    } catch (err) {
      log(`data callback failed: ${err.message}`)
      return
    }
    if (state.buffered === before) return // nobody consumed; wait for more
  }
}

function onPcm (chunk) {
  const bytes = state.pending.length ? Buffer.concat([state.pending, chunk]) : chunk
  const frameBytes = 4 * CHANNELS
  const frames = Math.floor(bytes.length / frameBytes)
  state.pending = Buffer.from(bytes.subarray(frames * frameBytes))
  if (!frames) return

  // Keep only the newest MAX_BUFFERED frames.
  const overflow = state.buffered + frames - MAX_BUFFERED
  if (overflow > 0) {
    const keep = Math.max(0, state.buffered - overflow)
    state.left.copyWithin(0, state.buffered - keep, state.buffered)
    state.right.copyWithin(0, state.buffered - keep, state.buffered)
    state.buffered = keep
  }
  const skip = Math.max(0, frames - MAX_BUFFERED)
  for (let f = skip; f < frames; f++) {
    const o = f * frameBytes
    state.left[state.buffered] = bytes.readFloatLE(o)
    state.right[state.buffered] = bytes.readFloatLE(o + 4)
    state.buffered++
  }
  emitData()
}

function stopChild () {
  clearInterval(state.linker)
  state.linker = null
  const child = state.child
  state.child = null
  state.buffered = 0
  state.pending = Buffer.alloc(0)
  if (child) child.kill('SIGTERM')
}


const api = {
  setLogCallback (cb) {
    state.logCb = cb
  },

  getAvailableContent (cb) {
    playingApps().then((apps) => {
      const applications = [
        { bundleIdentifier: SYSTEM, applicationName: 'All system audio' },
        ...apps.map((a) => ({ bundleIdentifier: APP_PREFIX + a.binary, applicationName: a.name }))
      ]
      cb.fn(0, JSON.stringify({ applications }))
    }).catch((err) => {
      log(`cannot list audio sources: ${err.message}`)
      cb.fn(0, JSON.stringify({ applications: [{ bundleIdentifier: SYSTEM, applicationName: 'All system audio' }] }))
    })
  },

  start (sourceId, statusCb, dataCb) {
    stopChild()
    state.dataCb = dataCb
    const binary = sourceId && sourceId.startsWith(APP_PREFIX) ? sourceId.slice(APP_PREFIX.length) : null
    state.nodeName = `nanoleaf-music-sync-${process.pid}-${Date.now()}`
    // Anything but an app id (including the frontend's own "" desktop entry)
    // means the whole system output.
    const props = binary ? 'node.autoconnect=false' : 'stream.capture.sink=true'
    log(binary ? `capturing ${binary}` : 'capturing all system audio')
    Promise.resolve().then(() => {
      const child = spawn('pw-record', [
        '-P', `{ ${props} node.name=${state.nodeName} media.name="Nanoleaf music sync" }`,
        // --raw: on stdout pw-record otherwise prepends an AU (.snd) header.
        '--raw', '--format', 'f32', '--rate', String(RATE), '--channels', String(CHANNELS),
        '--latency', '20ms', '-'
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
      state.child = child
      let started = false
      let stderr = ''
      child.stdout.on('data', (c) => { if (state.child === child) onPcm(c) })
      child.stderr.on('data', (c) => { stderr += c })
      child.on('spawn', () => {
        started = true
        if (binary) startLinker(binary)
        statusCb.fn(0)
      })
      child.on('error', (err) => {
        log(`cannot run pw-record: ${err.message}`)
        if (!started) statusCb.fn(-2)
      })
      child.on('exit', (code, signal) => {
        if (state.child === child) {
          log(`pw-record stopped unexpectedly (code ${code}, signal ${signal}) ${stderr.trim()}`)
          stopChild()
        }
      })
    }).catch((err) => {
      log(`cannot start audio capture: ${err.message}`)
      statusCb.fn(-2)
    })
  },

  stop (statusCb) {
    stopChild()
    setImmediate(() => statusCb.fn(0))
  },

  getFrameLength () {
    return Math.min(state.buffered, 4 * FRAME)
  },

  getData (left, right, n) {
    const count = Math.min(n, state.buffered, left.length, right.length)
    left.set(state.left.subarray(0, count))
    right.set(state.right.subarray(0, count))
    state.left.copyWithin(0, count, state.buffered)
    state.right.copyWithin(0, count, state.buffered)
    state.buffered -= count
    return count
  },

  getSampleRate () {
    return RATE
  }
}

module.exports = { api, state, _onPcm: onPcm }
