'use strict'

// Stand-in for Koffi's native module (koffi.node). Nanoleaf Desktop only uses
// koffi to drive its own Windows DLLs, so instead of a real FFI this forwards
// every call to nlbridge, which hosts the DLLs under Wine. Libraries without a
// working Wine path are served by JS stubs (see stubs.cjs).

const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { Worker, MessageChannel, receiveMessageOnPort } = require('node:worker_threads')
const stubs = require('./stubs.cjs')

const KOFFI_VERSION = '3.3.1'

const A_INT = 0, A_STR = 2, A_BUF = 3, A_BLOCK = 4, A_NULL = 5
const R_INT = 0, R_DOUBLE = 1
const T_RESP = 0x81, T_CB = 0x82, T_ADONE = 0x84

// Calls whose buffer arguments the DLL keeps writing to after returning.
// koffi passes Buffer memory directly, so this just works there; we have to
// keep the helper-side copy alive and sync it back when the callback that
// signals completion fires.
const RETAIN = {
  getSignatureAsync: { args: [0, 2], callbackArg: 4 }
}

const debug = !!process.env.NANOLEAF_SHIM_DEBUG
const log = (...a) => { if (debug) console.error('[koffi-shim]', ...a) }

// ---- wire helpers ---------------------------------------------------------

class Writer {
  constructor (type) { this.parts = []; this.u32(0); this.u8(type) }
  push (b) { this.parts.push(b); return this }
  u8 (v) { return this.push(Buffer.from([v & 0xff])) }
  u32 (v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return this.push(b) }
  u64 (v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt.asUintN(64, BigInt(v))); return this.push(b) }
  bytes (buf) { this.u32(buf.length); return this.push(buf) }
  finish () {
    const out = Buffer.concat(this.parts)
    out.writeUInt32LE(out.length - 4, 0)
    return new Uint8Array(out.buffer, out.byteOffset, out.length)
  }
}

class Reader {
  constructor (u8) { this.b = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength); this.o = 0 }
  u8 () { return this.b[this.o++] }
  u32 () { const v = this.b.readUInt32LE(this.o); this.o += 4; return v }
  u64 () { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v }
  bytes () { const n = this.u32(); const v = this.b.subarray(this.o, this.o + n); this.o += n; return v }
}

// ---- type system ------------------------------------------------------------

const PRIMITIVES = {
  void: { kind: 'void' },
  bool: { kind: 'int', size: 1, bool: true },
  char: { kind: 'int', size: 1, signed: true },
  'signed char': { kind: 'int', size: 1, signed: true },
  'unsigned char': { kind: 'int', size: 1, signed: false },
  uchar: { kind: 'int', size: 1, signed: false },
  int8_t: { kind: 'int', size: 1, signed: true },
  uint8_t: { kind: 'int', size: 1, signed: false },
  short: { kind: 'int', size: 2, signed: true },
  'unsigned short': { kind: 'int', size: 2, signed: false },
  int16_t: { kind: 'int', size: 2, signed: true },
  uint16_t: { kind: 'int', size: 2, signed: false },
  int: { kind: 'int', size: 4, signed: true },
  'signed int': { kind: 'int', size: 4, signed: true },
  unsigned: { kind: 'int', size: 4, signed: false },
  'unsigned int': { kind: 'int', size: 4, signed: false },
  uint: { kind: 'int', size: 4, signed: false },
  int32_t: { kind: 'int', size: 4, signed: true },
  uint32_t: { kind: 'int', size: 4, signed: false },
  // Win64 is LLP64: long is 32-bit on the DLL side.
  long: { kind: 'int', size: 4, signed: true },
  'unsigned long': { kind: 'int', size: 4, signed: false },
  'long long': { kind: 'int', size: 8, signed: true },
  'unsigned long long': { kind: 'int', size: 8, signed: false },
  int64_t: { kind: 'int', size: 8, signed: true },
  uint64_t: { kind: 'int', size: 8, signed: false },
  size_t: { kind: 'int', size: 8, signed: false },
  float: { kind: 'float', size: 4 },
  double: { kind: 'float', size: 8 }
}

const protos = new Map() // name -> { ret, params }
const structs = new Map() // name -> [{ name, type }]

function resolveBase (name) {
  if (PRIMITIVES[name]) return { ...PRIMITIVES[name], name }
  if (protos.has(name)) return { kind: 'proto', name }
  if (structs.has(name)) return { kind: 'struct', name }
  throw new TypeError(`koffi-shim: unknown type '${name}'`)
}

function parseType (str) {
  const isConst = /\bconst\b/.test(str)
  let s = str.replace(/\b(const|volatile|struct|_In_|_Out_|_Inout_)\b/g, '')
  let ptr = 0
  s = s.replace(/\*/g, () => { ptr++; return ' ' }).replace(/\s+/g, ' ').trim()
  const base = resolveBase(s)
  if (!ptr) return base
  return { kind: 'ptr', depth: ptr, base, isConst, name: str.trim() }
}

const TYPE_WORDS = new Set(['void', 'bool', 'char', 'short', 'int', 'long', 'float', 'double',
  'unsigned', 'signed', 'size_t', 'const', 'struct'])

// Splits "const int *inRgb" into its type, dropping the parameter name.
function stripParamName (p) {
  const m = /^(.*?)([A-Za-z_]\w*)\s*$/.exec(p)
  if (!m) return p
  const [, head, last] = m
  if (!head.trim() || TYPE_WORDS.has(last) || PRIMITIVES[last] || protos.has(last) || structs.has(last)) return p
  if (!/[\s*]$/.test(head)) return p
  return head
}

function parseSignature (sig) {
  const m = /^\s*(.+?)\s*\b([A-Za-z_]\w*)\s*\((.*)\)\s*;?\s*$/s.exec(sig)
  if (!m) throw new TypeError(`koffi-shim: cannot parse signature '${sig}'`)
  const [, retStr, name, paramStr] = m
  const params = paramStr.trim() === '' || paramStr.trim() === 'void'
    ? []
    : paramStr.split(',').map((p) => parseType(stripParamName(p.trim())))
  return { name, ret: parseType(retStr), params }
}

// ---- bridge -----------------------------------------------------------------

const CB_PTR = Symbol('koffi-shim callback')

function dataDir () {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'nanoleaf-linux')
}

class Bridge {
  constructor () {
    const helper = process.env.NANOLEAF_BRIDGE_HELPER ||
      path.join(process.resourcesPath || path.join(__dirname, '..'), 'nlbridge', 'nlbridge.exe.so')
    const wine = process.env.NANOLEAF_WINE || 'wine'
    const env = {
      ...process.env,
      WINEPREFIX: process.env.NANOLEAF_WINEPREFIX || path.join(dataDir(), 'wine'),
      WINEDEBUG: process.env.WINEDEBUG || '-all',
      // Skip the Mono/Gecko install prompts on first prefix creation.
      WINEDLLOVERRIDES: process.env.WINEDLLOVERRIDES || 'mscoree,mshtml='
    }
    fs.mkdirSync(path.dirname(env.WINEPREFIX), { recursive: true })

    this.flag = new Int32Array(new SharedArrayBuffer(4))
    const { port1, port2 } = new MessageChannel()
    this.syncPort = port1
    this.nextReq = 1
    this.pendingAsync = new Map() // req -> { done, views, ret }
    this.callbacks = new Map() // slot -> { fn, proto, ptr }
    this.releaseHooks = new Map() // callback ptr -> [{ ptr, view }]

    this.worker = new Worker(path.join(__dirname, 'bridge-worker.cjs'), {
      workerData: { sab: this.flag.buffer, syncPort: port2, wine, helper, env, token: crypto.randomBytes(16).toString('hex') },
      transferList: [port2]
    })
    this.worker.on('message', (frame) => this.onAsyncFrame(frame))
    this.worker.on('error', (err) => console.error('[koffi-shim] bridge worker failed:', err))
    this.worker.unref()

    const t0 = Date.now()
    const hello = this.waitSync()
    if (hello.type !== 'hello') throw new Error(`koffi-shim: ${hello.reason || 'bridge did not start'}`)
    log(`bridge up in ${Date.now() - t0} ms`)
  }

  waitSync () {
    for (;;) {
      const seen = Atomics.load(this.flag, 0)
      const m = receiveMessageOnPort(this.syncPort)
      if (m) return m.message
      Atomics.wait(this.flag, 0, seen)
    }
  }

  send (frame) { this.worker.postMessage(frame) }

  // Sends a request and blocks until its RESP, running any callbacks the DLL
  // fires on the helper's reader thread in the meantime (koffi semantics).
  request (req, frame) {
    this.send(frame)
    for (;;) {
      const msg = this.waitSync()
      if (msg.type === 'exit') throw new Error(`koffi-shim: ${msg.reason}`)
      if (msg[0] === T_CB) { this.runCallback(msg); continue }
      const r = new Reader(msg)
      r.u8()
      const id = r.u32()
      if (id !== req) throw new Error(`koffi-shim: out-of-order reply ${id} (expected ${req})`)
      return r
    }
  }

  simple (type, build) {
    const req = this.nextReq++
    const w = new Writer(type).u32(req)
    build(w)
    const r = this.request(req, w.finish())
    return { rax: r.u64(), extra: r.u64() }
  }

  load (file) {
    const { rax, extra } = this.simple(0x01, (w) => w.bytes(Buffer.from(file)))
    if (!rax) throw new Error(`koffi-shim: Wine could not load ${file} (error ${extra})`)
    return rax
  }

  symbol (handle, name) {
    const { rax } = this.simple(0x02, (w) => w.u64(handle).bytes(Buffer.from(name)))
    return rax
  }

  registerCallback (fn, proto) {
    const kinds = proto.params.map((p) => isStringPtr(p) ? A_STR : A_INT)
    const { rax, extra } = this.simple(0x04, (w) => { w.u8(kinds.length); kinds.forEach((k) => w.u8(k)) })
    if (!rax) throw new Error('koffi-shim: out of callback slots')
    this.callbacks.set(Number(extra), { fn, proto, ptr: rax })
    return rax
  }

  read (ptr, len) {
    const req = this.nextReq++
    const r = this.request(req, new Writer(0x07).u32(req).u64(ptr).u32(len).finish())
    r.u64(); r.u64(); r.u8()
    return r.bytes()
  }

  free (ptr) { this.simple(0x08, (w) => w.u64(ptr)) }

  releaseRetained (cbPtr) {
    const list = this.releaseHooks.get(cbPtr)
    if (!list) return
    this.releaseHooks.delete(cbPtr)
    for (const { ptr, view } of list) {
      if (view) this.read(ptr, view.length).copy(view)
      this.free(ptr)
    }
  }

  unregisterCallback (ptr) {
    for (const [slot, cb] of this.callbacks) {
      if (cb.ptr === ptr) this.callbacks.delete(slot)
    }
    this.simple(0x05, (w) => w.u64(ptr))
  }

  runCallback (frame) {
    const r = new Reader(frame)
    r.u8()
    const callId = r.u32()
    r.u8() // sync flag, already used for routing
    const slot = r.u32()
    const n = r.u8()
    const cb = this.callbacks.get(slot)
    if (cb) this.releaseRetained(cb.ptr)
    const args = []
    for (let i = 0; i < n; i++) {
      const kind = r.u8()
      if (kind === A_NULL) args.push(null)
      else if (kind === A_STR) args.push(r.bytes().toString('utf8'))
      else args.push(decodeInt(r.u64(), cb ? cb.proto.params[i] : PRIMITIVES.int))
    }
    try {
      if (cb) cb.fn(...args)
      else console.error(`[koffi-shim] callback for unknown slot ${slot}`)
    } catch (err) {
      console.error('[koffi-shim] callback threw:', err)
    } finally {
      this.send(new Writer(0x06).u32(callId).finish())
    }
  }

  onAsyncFrame (frame) {
    if (frame[0] === T_CB) return this.runCallback(frame)
    if (frame[0] !== T_ADONE) return
    const r = new Reader(frame)
    r.u8()
    const req = r.u32()
    const pending = this.pendingAsync.get(req)
    this.pendingAsync.delete(req)
    if (!this.pendingAsync.size) this.worker.unref()
    if (!pending) return
    let result
    try {
      result = finishCall(r, pending.fn, pending.views, pending.retained)
    } catch (err) {
      return pending.done(err)
    }
    pending.done(null, result)
  }
}

let bridge = null
function getBridge () {
  if (!bridge) bridge = new Bridge()
  return bridge
}

// ---- marshalling ------------------------------------------------------------

function isStringPtr (t) {
  return t.kind === 'ptr' && t.depth === 1 && t.base.kind === 'int' && t.base.size === 1
}

function decodeInt (raw, t) {
  if (t.kind !== 'int') return Number(BigInt.asIntN(32, raw))
  const bits = t.size * 8
  if (t.bool) return (raw & 0xffn) !== 0n
  return Number(t.signed ? BigInt.asIntN(bits, raw) : BigInt.asUintN(bits, raw))
}

function viewBytes (v) {
  if (Buffer.isBuffer(v)) return v
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
  if (v instanceof ArrayBuffer) return Buffer.from(v)
  return null
}

// A plain JS array passed for `T*` is copied in only, as koffi does.
function packArray (arr, t) {
  const base = t.base
  const size = base.kind === 'int' || base.kind === 'float' ? base.size : 8
  const out = Buffer.alloc(arr.length * size)
  arr.forEach((v, i) => {
    if (base.kind === 'float') {
      if (size === 4) out.writeFloatLE(v, i * 4)
      else out.writeDoubleLE(v, i * 8)
      return
    }
    const big = BigInt.asUintN(size * 8, BigInt(typeof v === 'boolean' ? +v : v))
    for (let b = 0; b < size; b++) out[i * size + b] = Number((big >> BigInt(8 * b)) & 0xffn)
  })
  return out
}

function encodeScalar (w, v, t, transient) {
  if (t.kind === 'ptr') {
    if (v == null) return w.u8(A_NULL)
    if (typeof v === 'object' && v[CB_PTR] != null) return w.u8(A_INT).u64(v[CB_PTR])
    if (typeof v === 'function' && t.base.kind === 'proto') {
      const ptr = getBridge().registerCallback(v, protos.get(t.base.name))
      transient.push(ptr)
      return w.u8(A_INT).u64(ptr)
    }
    if (typeof v === 'string') return w.u8(A_STR).bytes(Buffer.from(v + '', 'utf8'))
    if (typeof v === 'bigint') return w.u8(A_INT).u64(v)
    throw new TypeError(`koffi-shim: cannot pass ${typeof v} as ${t.name}`)
  }
  if (t.kind === 'int') {
    const n = typeof v === 'boolean' ? +v : (v ?? 0)
    return w.u8(A_INT).u64(BigInt.asUintN(64, BigInt(typeof n === 'number' ? Math.trunc(n) : n)))
  }
  throw new TypeError(`koffi-shim: unsupported argument type ${t.name || t.kind}`)
}

function encodeArg (w, v, t, views, transient, retained) {
  if (t.kind === 'ptr' && v != null && typeof v === 'object' && v[CB_PTR] == null) {
    const bytes = viewBytes(v)
    if (bytes) {
      const wb = !t.isConst
      w.u8(A_BUF).u8((wb ? 1 : 0) | (retained ? 2 : 0)).bytes(bytes)
      if (wb) views.push(bytes)
      if (retained) retained.views.push(wb ? bytes : null)
      return
    }
    if (Array.isArray(v)) return w.u8(A_BUF).u8(0).bytes(packArray(v, t))
  }
  if (t.kind === 'struct') {
    const fields = structs.get(t.name)
    w.u8(A_BLOCK).u8(fields.length)
    for (const f of fields) {
      if (f.type.kind === 'struct' || (f.type.kind === 'int' && f.type.size > 8)) {
        throw new TypeError('koffi-shim: nested structs are not supported')
      }
      encodeScalar(w, v[f.name], f.type, transient)
    }
    return
  }
  if (t.kind === 'float') throw new TypeError('koffi-shim: float arguments are not supported')
  encodeScalar(w, v, t, transient)
}

function finishCall (r, fn, views, retained) {
  const rax = r.u64()
  const xmm = r.u64()
  const nwb = r.u8()
  for (let i = 0; i < nwb; i++) r.bytes().copy(views[i])
  const nret = r.u8()
  if (nret) {
    const list = retained.views.map((view) => ({ ptr: r.u64(), view }))
    getBridge().releaseHooks.set(retained.cbPtr, list)
  }
  const t = fn.ret
  if (t.kind === 'void') return undefined
  if (t.kind === 'float') {
    const b = Buffer.alloc(8)
    b.writeBigUInt64LE(xmm)
    return t.size === 4 ? b.readFloatLE(0) : b.readDoubleLE(0)
  }
  if (t.kind === 'ptr') return rax === 0n ? null : rax
  return decodeInt(rax, t)
}

function buildCall (req, async, addr, fn, args) {
  if (args.length !== fn.params.length) {
    throw new TypeError(`koffi-shim: ${fn.name} expects ${fn.params.length} arguments, got ${args.length}`)
  }
  const views = []
  const transient = []
  const policy = RETAIN[fn.name]
  let retained = null
  if (policy) {
    const cb = args[policy.callbackArg]
    if (!cb || cb[CB_PTR] == null) throw new TypeError(`koffi-shim: ${fn.name} needs a registered callback`)
    retained = { cbPtr: cb[CB_PTR], views: [] }
  }
  const w = new Writer(0x03).u32(req).u8(async ? 1 : 0).u64(addr)
    .u8(fn.ret.kind === 'float' ? R_DOUBLE : R_INT).u8(args.length)
  fn.params.forEach((t, i) => encodeArg(w, args[i], t, views, transient,
    policy && policy.args.includes(i) ? retained : null))
  return { frame: w.finish(), views, transient, retained }
}

function bridgedFunction (handle, sig) {
  const fn = parseSignature(sig)
  const b = getBridge()
  const addr = b.symbol(handle, fn.name)
  if (!addr) throw new Error(`koffi-shim: symbol ${fn.name} not found`)

  const call = (...args) => {
    const req = b.nextReq++
    const { frame, views, transient, retained } = buildCall(req, false, addr, fn, args)
    try {
      return finishCall(b.request(req, frame), fn, views, retained)
    } finally {
      transient.forEach((p) => b.unregisterCallback(p))
    }
  }
  call.async = (...args) => {
    const done = args.pop()
    if (typeof done !== 'function') throw new TypeError('koffi-shim: async call needs a callback')
    const req = b.nextReq++
    let built
    try {
      built = buildCall(req, true, addr, fn, args)
    } catch (err) {
      return process.nextTick(done, err)
    }
    // Like koffi, an in-flight async call keeps the event loop alive.
    if (!b.pendingAsync.size) b.worker.ref()
    b.pendingAsync.set(req, {
      fn,
      views: built.views,
      retained: built.retained,
      done: (err, res) => {
        built.transient.forEach((p) => b.unregisterCallback(p))
        done(err, res)
      }
    })
    b.send(built.frame)
  }
  Object.defineProperty(call, 'name', { value: fn.name })
  return call
}

// ---- koffi native API surface ------------------------------------------------

function libraryBaseName (file) {
  return path.basename(file).replace(/\.(dylib|so|dll)$/i, '')
}

function load (file) {
  const name = libraryBaseName(file)
  if (stubs[name]) {
    log(`${name}: using JS stub`)
    return {
      func: (...a) => {
        const impl = stubs.makeFunction(name, parseSignature(a[a.length - 1]))
        const fn = (...args) => impl(...args)
        fn.async = (...args) => {
          const done = args.pop()
          setImmediate(() => {
            let res
            try { res = impl(...args) } catch (err) { return done(err) }
            done(null, res)
          })
        }
        return fn
      },
      unload () {}
    }
  }
  const dll = path.resolve(path.dirname(file), `${name}.dll`)
  const handle = getBridge().load(dll)
  log(`${name}: loaded under Wine`)
  return {
    func: (...a) => bridgedFunction(handle, a[a.length - 1]),
    unload () {}
  }
}

function proto (sig) {
  const p = parseSignature(sig)
  protos.set(p.name, p)
  return { name: p.name }
}

function struct (name, def) {
  if (typeof name !== 'string') throw new TypeError('koffi-shim: anonymous structs are not supported')
  structs.set(name, Object.entries(def).map(([k, v]) => ({ name: k, type: parseType(v) })))
  return { name }
}

function register (fn, type) {
  const name = String(type).replace(/\*\s*$/, '').trim()
  const p = protos.get(name)
  if (!p) throw new TypeError(`koffi-shim: unknown callback type '${type}'`)
  if (stubs.isStubCallbackType(name)) return { [CB_PTR]: 0n, fn, proto: p }
  const ptr = getBridge().registerCallback(fn, p)
  return { [CB_PTR]: ptr, fn, proto: p }
}

function unregister (handle) {
  if (!handle || !handle[CB_PTR]) return
  getBridge().unregisterCallback(handle[CB_PTR])
}

function type (t) {
  const resolved = typeof t === 'string' ? parseType(t) : t
  return { ...resolved, size: resolved.size || 8, alignment: resolved.size || 8, primitive: resolved.kind }
}

const unsupported = (what) => () => { throw new Error(`koffi-shim: koffi.${what}() is not implemented`) }

module.exports = {
  version: KOFFI_VERSION,
  load,
  proto,
  struct,
  register,
  unregister,
  type,
  pointer: (t) => typeof t === 'string' ? `${t}*` : t,
  opaque: (name) => ({ name }),
  alias: unsupported('alias'),
  array: unsupported('array'),
  decode: unsupported('decode'),
  encode: unsupported('encode'),
  alloc: unsupported('alloc'),
  free: unsupported('free'),
  address: unsupported('address'),
  as: unsupported('as'),
  out: (t) => t,
  in: (t) => t,
  inout: (t) => t,
  config: () => ({}),
  stats: () => ({}),
  // exposed for tests
  _internal: { parseSignature, getBridge }
}
