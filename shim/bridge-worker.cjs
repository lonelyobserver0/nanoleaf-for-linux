'use strict'

// Owns the TCP connection to nlbridge (running under Wine) so the main thread
// can block synchronously on replies. Frames that answer a synchronous call go
// through `syncPort` + an Atomics bump; everything else (async completions,
// callbacks fired from DLL threads) goes to the parent as a regular message.

const net = require('node:net')
const { spawn } = require('node:child_process')
const { parentPort, workerData } = require('node:worker_threads')

const { sab, syncPort, wine, helper, env, token } = workerData
const flag = new Int32Array(sab)

const T_RESP = 0x81, T_CB = 0x82, T_HELLO = 0x83

function toMain (msg) {
  syncPort.postMessage(msg)
  Atomics.add(flag, 0, 1)
  Atomics.notify(flag, 0)
}

let sock = null
const queue = []

parentPort.on('message', (frame) => {
  const buf = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength)
  if (sock) sock.write(buf)
  else queue.push(buf)
})

const server = net.createServer((s) => {
  let acc = Buffer.alloc(0)
  let authed = false
  s.setNoDelay(true)
  s.on('data', (chunk) => {
    acc = acc.length ? Buffer.concat([acc, chunk]) : chunk
    while (acc.length >= 4) {
      const len = acc.readUInt32LE(0)
      if (acc.length < 4 + len) break
      const body = acc.subarray(4, 4 + len)
      acc = acc.subarray(4 + len)
      const type = body[0]
      if (!authed) {
        // The first frame must be HELLO carrying our token; anything else is
        // some other local process that raced us to the port.
        const ok = type === T_HELLO && body.subarray(5).toString() === token
        if (!ok) { s.destroy(); return }
        authed = true
        sock = s
        server.close()
        for (const q of queue.splice(0)) s.write(q)
        toMain({ type: 'hello' })
        continue
      }
      // Copy out: `body` is a view on a buffer we keep slicing.
      const frame = new Uint8Array(body)
      if (type === T_RESP || (type === T_CB && body[5] === 1)) toMain(frame)
      else parentPort.postMessage(frame)
    }
  })
  s.on('close', () => {
    if (s === sock) toMain({ type: 'exit', reason: 'helper connection closed' })
  })
})

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  const child = spawn(wine, [helper, String(port), token], {
    env,
    // The DLLs get Unix paths from the app (e.g. the LTPDU credentials dir).
    // Wine resolves "/home/..." against the current drive, which is Z: (the
    // Unix root) only if the working directory maps there.
    cwd: '/',
    stdio: ['ignore', 'inherit', 'inherit']
  })
  child.on('error', (err) => toMain({ type: 'exit', reason: `cannot start ${wine}: ${err.message}` }))
  child.on('exit', (code, signal) => {
    if (!sock) toMain({ type: 'exit', reason: `helper exited early (code ${code}, signal ${signal})` })
  })
})
