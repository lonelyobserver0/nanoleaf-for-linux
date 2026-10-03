'use strict'

// JS replacements for the DLLs that depend on Windows-only APIs. Screen
// Mirror (screen-mirror.cjs) and music sync audio (audio.cjs) have real Linux
// implementations; Razer Chroma reports "nothing available".

const writeCString = (buf, str) => {
  if (!buf) return
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  const n = b.write(str, 0, Math.max(0, b.length - 1), 'utf8')
  b[n] = 0
}

const libs = {
  libScreenMirror: require('./screen-mirror.cjs').api,
  libRCC: {
    setRazerChromaConfig: () => 0,
    startRazerChroma: () => -1,
    stopRazerChroma: () => 0,
    getSizeOfStreamFrameJson: () => 0,
    getStreamFrameJson: (buf) => { writeCString(buf, ''); return 0 },
    isBroadcastLive: () => 0,
    setExtLogCallback: () => {}
  },
  libAudio: require('./audio.cjs').api
}

const STUB_CALLBACK_TYPES = new Set([
  'ScreenMirrorDataAvailableCallback', 'ScreenMirrorLogCallback',
  'RazerChromaDataAvailableCallback', 'RazerChromaLogCallback',
  'AudioAvailableContentCallback', 'AudioDataAvailableCallback',
  'AudioLogCallback', 'AudioStatusCallback'
])

function makeFunction (lib, sig) {
  const impl = libs[lib][sig.name]
  if (impl) return impl
  return () => {
    console.warn(`[koffi-shim] ${lib}.${sig.name} is not implemented on Linux`)
    return sig.ret.kind === 'void' ? undefined : 0
  }
}

module.exports = {
  ...libs,
  makeFunction,
  isStubCallbackType: (name) => STUB_CALLBACK_TYPES.has(name)
}
