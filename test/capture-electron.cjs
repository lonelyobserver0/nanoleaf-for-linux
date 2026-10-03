'use strict'
// Manual check of the real screen capture (opens the portal picker on Wayland):
// build/electron-<ver>/dist/electron test/capture-electron.cjs
const { app } = require('electron')
const { ScreenCapture, displays } = require('../shim/screen-capture.cjs')

// The failed portal attempt destroys our only window; don't quit on that.
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  console.log('displays', displays())
  let n = 0, first = 0
  const cap = new ScreenCapture({
    log: (m) => console.log('[capture]', m),
    onFrame: (img) => {
      if (!n++) first = Date.now()
      if (n % 10 === 0) {
        let r = 0, g = 0, b = 0
        for (let i = 0; i < img.data.length; i += 4) { r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2] }
        const px = img.data.length / 4
        const fps = (n - 1) / ((Date.now() - first) / 1000)
        console.log(`frame ${n} ${img.width}x${img.height} mean rgb ${[r, g, b].map((v) => Math.round(v / px))} ~${fps.toFixed(1)} fps`)
      }
    }
  })
  try {
    await cap.start(0, 10)
  } catch (err) {
    console.error('start failed:', err.message)
    app.exit(1)
  }
  setTimeout(() => { console.log(n ? `OK: ${n} frames` : 'FAIL: no frames'); app.exit(n ? 0 : 1) }, 12000)
})
