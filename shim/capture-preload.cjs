'use strict'

// Runs in the hidden capture window. Grabs frames from the desktop stream,
// shrinks them and posts the RGBA pixels to the main process.

const { ipcRenderer } = require('electron')

const CH = 'nanoleaf-linux:capture'

let stream = null
let grabber = null
let video = null
let timer = null
let opts = { width: 96, fps: 10 }
const canvas = new OffscreenCanvas(1, 1)
const ctx = canvas.getContext('2d', { willReadFrequently: true })

function stopLoop () {
  clearTimeout(timer)
  timer = null
}

function release () {
  stopLoop()
  stream?.getTracks().forEach((t) => t.stop())
  stream = grabber = video = null
}

async function grab () {
  if (grabber) {
    try {
      return await grabber.grabFrame()
    } catch {
      grabber = null // fall back to a <video> element below
    }
  }
  if (!video) {
    video = document.createElement('video')
    video.muted = true
    video.srcObject = stream
    await video.play()
  }
  return video
}

async function tick () {
  const started = performance.now()
  try {
    const src = await grab()
    const sw = src.width || src.videoWidth, sh = src.height || src.videoHeight
    if (sw && sh) {
      const w = opts.width, h = Math.max(1, Math.round(w * sh / sw))
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
      ctx.drawImage(src, 0, 0, w, h)
      if (src.close) src.close()
      const img = ctx.getImageData(0, 0, w, h)
      ipcRenderer.send(`${CH}-frame`, { width: w, height: h, data: img.data })
    }
  } catch (err) {
    ipcRenderer.send(`${CH}-error`, String(err && err.message ? err.message : err))
  }
  if (stream) timer = setTimeout(tick, Math.max(0, 1000 / opts.fps - (performance.now() - started)))
}

ipcRenderer.on(`${CH}-start`, async (_e, { sourceId, width, fps }) => {
  release()
  opts = { width, fps }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: Math.max(fps, 5) } }
    })
  } catch (err) {
    ipcRenderer.send(`${CH}-error`, `getUserMedia failed: ${err.message}`)
    return
  }
  const [track] = stream.getVideoTracks()
  track.addEventListener('ended', () => { release(); ipcRenderer.send(`${CH}-ended`) })
  if (typeof ImageCapture === 'function') grabber = new ImageCapture(track)
  ipcRenderer.send(`${CH}-started`)
  tick()
})

ipcRenderer.on(`${CH}-config`, (_e, { fps, paused }) => {
  if (fps) opts.fps = fps
  if (paused) stopLoop()
  else if (stream && !timer) tick()
})
