'use strict'

// Screen capture for Screen Mirror on Linux. Two backends:
//  - portal: Chromium's desktop capturer (PipeWire + xdg-desktop-portal on
//    Wayland, X11 directly otherwise), driven from a hidden window;
//  - grim:   wlr-screencopy via the grim CLI, for wlroots compositors
//    (Hyprland, sway) without a ScreenCast portal. No picker prompt.
// NANOLEAF_CAPTURE=portal|grim forces one; by default the portal is tried
// first and grim is the fallback.

const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { BrowserWindow, desktopCapturer, ipcMain, screen } = require('electron')

const CH = 'nanoleaf-linux:capture'
const WIDTH = 96 // analysis resolution; panels never need more
// On Wayland every new stream means a portal prompt, so a stopped capture is
// kept (paused) for a while: the app often restarts Screen Mirror to change
// settings.
const RELEASE_AFTER_MS = 2 * 60 * 1000

function displays () {
  return screen.getAllDisplays().map((d) => ({
    displayID: d.id,
    width: Math.round(d.size.width * d.scaleFactor),
    height: Math.round(d.size.height * d.scaleFactor)
  }))
}

class PortalCapture {
  constructor ({ onFrame, log }) {
    this.onFrame = onFrame
    this.log = log
    this.win = null
    this.displayIndex = null
    this.releaseTimer = null
    this.starting = null

    const fromUs = (e) => this.win && !this.win.isDestroyed() && e.sender === this.win.webContents
    ipcMain.on(`${CH}-frame`, (e, img) => { if (fromUs(e)) this.onFrame(img) })
    ipcMain.on(`${CH}-started`, (e) => { if (fromUs(e)) this.log('capture started') })
    ipcMain.on(`${CH}-error`, (e, msg) => { if (fromUs(e)) this.log(`capture error: ${msg}`) })
    ipcMain.on(`${CH}-ended`, (e) => {
      if (!fromUs(e)) return
      this.log('capture ended by the system (sharing stopped)')
      this.destroy()
    })
  }

  async start (displayIndex, fps) {
    clearTimeout(this.releaseTimer)
    if (this.win && !this.win.isDestroyed() && this.displayIndex === displayIndex) {
      this.win.webContents.send(`${CH}-config`, { fps, paused: false })
      return
    }
    this.destroy()
    this.displayIndex = displayIndex

    const win = new BrowserWindow({
      show: false,
      width: 200,
      height: 120,
      webPreferences: {
        partition: 'nanoleaf-linux-capture',
        preload: path.join(__dirname, 'capture-preload.cjs'),
        backgroundThrottling: false
      }
    })
    this.win = win
    await win.loadURL('data:text/html,<!doctype html><title>Nanoleaf screen capture</title>')

    // On Wayland this opens the portal picker and yields the chosen screen.
    let sources
    try {
      sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
    } catch (err) {
      this.destroy()
      // Chromium rejects with a bare value when the portal is missing.
      throw new Error(`desktop capturer failed (${err?.message ?? err}); is a ScreenCast portal installed?`)
    }
    if (win.isDestroyed()) return
    if (!sources.length) {
      this.destroy()
      throw new Error('no screen available (portal request cancelled?)')
    }
    const wanted = displays()[displayIndex]
    const source = sources.find((s) => wanted && s.display_id === String(wanted.displayID)) ?? sources[0]
    this.log(`capturing ${source.name || source.id}`)
    win.webContents.send(`${CH}-start`, { sourceId: source.id, width: WIDTH, fps })
  }

  setFps (fps) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(`${CH}-config`, { fps })
  }

  stop () {
    if (!this.win || this.win.isDestroyed()) return
    this.win.webContents.send(`${CH}-config`, { paused: true })
    clearTimeout(this.releaseTimer)
    this.releaseTimer = setTimeout(() => this.destroy(), RELEASE_AFTER_MS)
  }

  destroy () {
    clearTimeout(this.releaseTimer)
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
    this.displayIndex = null
  }
}

// Reads one binary PPM (P6) image.
function parsePpm (buf) {
  let pos = 0
  const token = () => {
    while (pos < buf.length) {
      const c = buf[pos]
      if (c === 0x23) { while (pos < buf.length && buf[pos] !== 0x0a) pos++ } // comment
      else if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) pos++
      else break
    }
    const start = pos
    while (pos < buf.length && buf[pos] > 0x20) pos++
    return buf.toString('latin1', start, pos)
  }
  if (token() !== 'P6') throw new Error('not a P6 PPM image')
  const width = +token(), height = +token(), max = +token()
  if (max !== 255) throw new Error(`unsupported PPM depth ${max}`)
  pos++ // single whitespace before the pixels
  return { width, height, rgb: buf.subarray(pos, pos + width * height * 3) }
}

// Box-downscales RGB to RGBA at `width` columns, sampling a 4x4 grid per cell:
// plenty for colour averages and ~100x cheaper than touching every pixel.
function downscale ({ width: sw, height: sh, rgb }, width) {
  const height = Math.max(1, Math.round(width * sh / sw))
  const data = new Uint8ClampedArray(width * height * 4)
  const S = 4
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0
      for (let j = 0; j < S; j++) {
        const sy = Math.min(sh - 1, Math.floor((y + (j + 0.5) / S) * sh / height))
        for (let i = 0; i < S; i++) {
          const sx = Math.min(sw - 1, Math.floor((x + (i + 0.5) / S) * sw / width))
          const o = (sy * sw + sx) * 3
          r += rgb[o]; g += rgb[o + 1]; b += rgb[o + 2]
        }
      }
      const o = (y * width + x) * 4
      data[o] = r / (S * S); data[o + 1] = g / (S * S); data[o + 2] = b / (S * S); data[o + 3] = 255
    }
  }
  return { width, height, data }
}

class GrimCapture {
  constructor ({ onFrame, log }) {
    this.onFrame = onFrame
    this.log = log
    this.running = false
    this.timer = null
    this.fps = 8
    this.geometry = null
  }

  static available () {
    return !!process.env.WAYLAND_DISPLAY && spawnSync('grim', ['-h'], { stdio: 'ignore' }).error === undefined
  }

  async start (displayIndex, fps) {
    const d = screen.getAllDisplays()[displayIndex] ?? screen.getPrimaryDisplay()
    const { x, y, width, height } = d.bounds
    this.geometry = `${x},${y} ${width}x${height}`
    // Each grab moves a full-resolution frame through a pipe; keep it modest.
    this.fps = Math.min(fps, 8)
    if (!this.running) {
      this.running = true
      this.log(`capturing ${this.geometry} with grim`)
      this.loop()
    }
  }

  loop () {
    if (!this.running) return
    const started = Date.now()
    const chunks = []
    const child = spawn('grim', ['-g', this.geometry, '-t', 'ppm', '-'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stdout.on('data', (c) => chunks.push(c))
    child.stderr.on('data', (c) => { err += c })
    child.on('error', (e) => { this.log(`grim failed: ${e.message}`); this.running = false })
    child.on('close', (code) => {
      if (!this.running) return
      if (code === 0) {
        try {
          this.onFrame(downscale(parsePpm(Buffer.concat(chunks)), WIDTH))
        } catch (e) {
          this.log(`bad grim frame: ${e.message}`)
        }
      } else {
        this.log(`grim exited with ${code}: ${err.trim()}`)
      }
      this.timer = setTimeout(() => this.loop(), Math.max(0, 1000 / this.fps - (Date.now() - started)))
    })
  }

  setFps (fps) { this.fps = Math.min(fps, 8) }

  stop () {
    this.running = false
    clearTimeout(this.timer)
  }

  destroy () { this.stop() }
}

// Picks the backend on first start and sticks with what worked.
class ScreenCapture {
  constructor (opts) {
    this.opts = opts
    this.backend = null
    this.forced = process.env.NANOLEAF_CAPTURE
  }

  async start (displayIndex, fps) {
    if (this.backend) return this.backend.start(displayIndex, fps)
    if (this.forced !== 'grim') {
      const portal = new PortalCapture(this.opts)
      try {
        await portal.start(displayIndex, fps)
        this.backend = portal
        return
      } catch (err) {
        portal.destroy()
        if (this.forced === 'portal' || !GrimCapture.available()) throw err
        this.opts.log(`${err.message}; falling back to grim`)
      }
    }
    this.backend = new GrimCapture(this.opts)
    return this.backend.start(displayIndex, fps)
  }

  setFps (fps) { this.backend?.setFps(fps) }
  stop () { this.backend?.stop() }
  destroy () { this.backend?.destroy() }
}

module.exports = { ScreenCapture, displays, parsePpm, downscale }
