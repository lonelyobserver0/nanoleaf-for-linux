/*
 * nlbridge — hosts the Nanoleaf Desktop Windows DLLs under Wine and exposes
 * them to the Linux koffi shim over a localhost TCP socket.
 *
 * Built as a winelib program (winegcc). Code here is SysV ABI; everything we
 * call in, or get called back from, the DLLs is ms_abi.
 *
 * Wire format: every frame is [u32 length][u8 type][payload], little endian.
 *
 *   node -> helper                       helper -> node
 *   0x01 LOAD   req path                 0x81 RESP   req rax xmm0 nwb {len bytes}*
 *   0x02 SYM    req handle name          0x82 CB     call sync slot nargs args
 *   0x03 CALL   req async fn ret n args  0x83 HELLO  token
 *   0x04 CBREG  req nargs kinds[]        0x84 ADONE  same body as RESP
 *   0x05 CBFREE req ptr
 *   0x06 CBDONE call
 *   0x07 READ   req ptr len   (RESP carries the bytes as its one write-back)
 *   0x08 FREE   req ptr
 *
 * RESP/ADONE end with u8 nret + u64 ptr per retained buffer.
 *
 * Arguments: 0 INT u64 | 2 STR u32 len bytes | 3 BUF u8 flags u32 len bytes |
 *            4 BLOCK u8 n (INT|STR)* | 5 NULL
 * BUF flags: bit 0 copy back after the call, bit 1 retain (the DLL keeps the
 * pointer past the call; node READs and FREEs it later).
 *
 * Sync calls run on the reader thread. A callback fired on that thread sends
 * CB with sync=1 and keeps serving requests (the JS handler may call back into
 * the DLL) until the matching CBDONE. Callbacks from other threads block on an
 * event until their CBDONE arrives, which mirrors what koffi does.
 */

#include <winsock2.h>
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_ARGS 12
#define MAX_CB 64
#define MAX_PENDING 256

enum { A_INT = 0, A_STR = 2, A_BUF = 3, A_BLOCK = 4, A_NULL = 5 };
enum { R_INT = 0, R_DOUBLE = 1 };

static SOCKET sock = INVALID_SOCKET;
static CRITICAL_SECTION send_lock, state_lock;
static DWORD reader_tid;
static volatile LONG next_call_id;

static void die(const char *msg)
{
    fprintf(stderr, "[nlbridge] fatal: %s\n", msg);
    fflush(stderr);
    ExitProcess(1);
}

/* ---- buffers ---------------------------------------------------------- */

typedef struct { uint8_t *p; size_t n, cap; } wbuf;

static void wb_put(wbuf *w, const void *d, size_t n)
{
    if (w->n + n > w->cap) {
        size_t cap = w->cap ? w->cap : 256;
        while (cap < w->n + n) cap *= 2;
        if (!(w->p = realloc(w->p, cap))) die("out of memory");
        w->cap = cap;
    }
    memcpy(w->p + w->n, d, n);
    w->n += n;
}
static void wb_u8(wbuf *w, uint8_t v) { wb_put(w, &v, 1); }
static void wb_u32(wbuf *w, uint32_t v) { wb_put(w, &v, 4); }
static void wb_u64(wbuf *w, uint64_t v) { wb_put(w, &v, 8); }
static void wb_begin(wbuf *w, uint8_t type) { w->n = 0; wb_u32(w, 0); wb_u8(w, type); }

typedef struct { const uint8_t *p, *end; } rbuf;

static void rb_get(rbuf *r, void *d, size_t n)
{
    if ((size_t)(r->end - r->p) < n) die("truncated frame");
    memcpy(d, r->p, n);
    r->p += n;
}
static uint8_t rb_u8(rbuf *r) { uint8_t v; rb_get(r, &v, 1); return v; }
static uint32_t rb_u32(rbuf *r) { uint32_t v; rb_get(r, &v, 4); return v; }
static uint64_t rb_u64(rbuf *r) { uint64_t v; rb_get(r, &v, 8); return v; }

/* Returns a malloc'd, NUL-terminated copy of a length-prefixed field. */
static char *rb_bytes(rbuf *r, uint32_t *len_out)
{
    uint32_t n = rb_u32(r);
    char *s = malloc((size_t)n + 1);
    if (!s) die("out of memory");
    rb_get(r, s, n);
    s[n] = 0;
    if (len_out) *len_out = n;
    return s;
}

/* ---- socket ----------------------------------------------------------- */

static void send_frame(wbuf *w)
{
    uint32_t len = (uint32_t)(w->n - 4);
    memcpy(w->p, &len, 4);
    EnterCriticalSection(&send_lock);
    size_t off = 0;
    while (off < w->n) {
        int k = send(sock, (const char *)w->p + off, (int)(w->n - off), 0);
        if (k <= 0) { LeaveCriticalSection(&send_lock); die("socket send failed"); }
        off += k;
    }
    LeaveCriticalSection(&send_lock);
}

static void recv_all(void *d, size_t n)
{
    size_t off = 0;
    while (off < n) {
        int k = recv(sock, (char *)d + off, (int)(n - off), 0);
        if (k <= 0) ExitProcess(0); /* node went away: nothing left to do */
        off += k;
    }
}

/* ---- pending callbacks from non-reader threads ------------------------ */

static struct { LONG id; HANDLE ev; } pending[MAX_PENDING];

static void pending_signal(LONG id)
{
    EnterCriticalSection(&state_lock);
    for (int i = 0; i < MAX_PENDING; i++)
        if (pending[i].ev && pending[i].id == id) { SetEvent(pending[i].ev); break; }
    LeaveCriticalSection(&state_lock);
}

/* ---- callbacks -------------------------------------------------------- */

typedef struct { int used; uint8_t nargs; uint8_t kinds[4]; } cbslot;
static cbslot cbs[MAX_CB];

static void serve_until(LONG call_id);

static void dispatch_cb(int slot, const uint64_t a[4])
{
    LONG id = InterlockedIncrement(&next_call_id);
    int sync = GetCurrentThreadId() == reader_tid;
    cbslot *cb = &cbs[slot];

    wbuf w = {0};
    wb_begin(&w, 0x82);
    wb_u32(&w, (uint32_t)id);
    wb_u8(&w, (uint8_t)sync);
    wb_u32(&w, (uint32_t)slot);
    wb_u8(&w, cb->nargs);
    for (int i = 0; i < cb->nargs && i < 4; i++) {
        if (cb->kinds[i] == A_STR) {
            const char *s = (const char *)(uintptr_t)a[i];
            if (!s) { wb_u8(&w, A_NULL); continue; }
            uint32_t n = (uint32_t)strlen(s);
            wb_u8(&w, A_STR); wb_u32(&w, n); wb_put(&w, s, n);
        } else {
            wb_u8(&w, A_INT); wb_u64(&w, a[i]);
        }
    }

    if (sync) {
        send_frame(&w);
        serve_until(id);
    } else {
        HANDLE ev = CreateEventA(NULL, FALSE, FALSE, NULL);
        int idx = -1;
        while (idx < 0) {
            EnterCriticalSection(&state_lock);
            for (int i = 0; i < MAX_PENDING; i++)
                if (!pending[i].ev) { pending[i].id = id; pending[i].ev = ev; idx = i; break; }
            LeaveCriticalSection(&state_lock);
            if (idx < 0) Sleep(1);
        }
        send_frame(&w);
        WaitForSingleObject(ev, INFINITE);
        EnterCriticalSection(&state_lock);
        pending[idx].ev = NULL;
        LeaveCriticalSection(&state_lock);
        CloseHandle(ev);
    }
    free(w.p);
}

#define STUB(i) \
    static void __attribute__((ms_abi)) cb_##i(uint64_t a, uint64_t b, uint64_t c, uint64_t d) \
    { uint64_t v[4] = {a, b, c, d}; dispatch_cb(i, v); }
#define STUB8(i) STUB(i##0) STUB(i##1) STUB(i##2) STUB(i##3) STUB(i##4) STUB(i##5) STUB(i##6) STUB(i##7)
STUB8(0) STUB8(1) STUB8(2) STUB8(3) STUB8(4) STUB8(5) STUB8(6) STUB8(7)
#define REF8(i) cb_##i##0, cb_##i##1, cb_##i##2, cb_##i##3, cb_##i##4, cb_##i##5, cb_##i##6, cb_##i##7
static void *cb_table[MAX_CB] = { REF8(0), REF8(1), REF8(2), REF8(3), REF8(4), REF8(5), REF8(6), REF8(7) };

/* ---- calls ------------------------------------------------------------ */

typedef uint64_t (__attribute__((ms_abi)) *fn_int)(uint64_t, uint64_t, uint64_t, uint64_t,
    uint64_t, uint64_t, uint64_t, uint64_t, uint64_t, uint64_t, uint64_t, uint64_t);
typedef double (__attribute__((ms_abi)) *fn_dbl)(uint64_t, uint64_t, uint64_t, uint64_t,
    uint64_t, uint64_t, uint64_t, uint64_t, uint64_t, uint64_t, uint64_t, uint64_t);

typedef struct {
    uint32_t req;
    void *fn;
    uint8_t ret;
    uint64_t a[MAX_ARGS];
    int nbuf;
    struct { void *p; uint32_t n; } bufs[MAX_ARGS]; /* write-back buffers */
    int nret;
    void *retained[MAX_ARGS];
    int nalloc;
    void *allocs[MAX_ARGS * 8];
} call_t;

static void *call_alloc(call_t *c, size_t n)
{
    if (c->nalloc >= (int)(sizeof c->allocs / sizeof *c->allocs)) die("too many allocations");
    void *p = calloc(1, n ? n : 1);
    if (!p) die("out of memory");
    return c->allocs[c->nalloc++] = p;
}

static uint64_t parse_scalar(rbuf *r, call_t *c, uint8_t kind)
{
    switch (kind) {
    case A_INT: return rb_u64(r);
    case A_NULL: return 0;
    case A_STR: {
        if (c->nalloc >= (int)(sizeof c->allocs / sizeof *c->allocs)) die("too many allocations");
        char *s = rb_bytes(r, NULL);
        c->allocs[c->nalloc++] = s;
        return (uintptr_t)s;
    }
    default: die("bad argument kind"); return 0;
    }
}

static call_t *parse_call(rbuf *r, uint8_t *async)
{
    call_t *c = calloc(1, sizeof *c);
    if (!c) die("out of memory");
    c->req = rb_u32(r);
    *async = rb_u8(r);
    c->fn = (void *)(uintptr_t)rb_u64(r);
    c->ret = rb_u8(r);
    uint8_t n = rb_u8(r);
    if (n > MAX_ARGS) die("too many arguments");
    for (int i = 0; i < n; i++) {
        uint8_t kind = rb_u8(r);
        if (kind == A_BUF) {
            uint8_t flags = rb_u8(r);
            uint32_t len = rb_u32(r);
            void *p;
            if (flags & 2) {
                if (!(p = calloc(1, len ? len : 1))) die("out of memory");
                c->retained[c->nret++] = p;
            } else {
                p = call_alloc(c, len);
            }
            rb_get(r, p, len);
            c->a[i] = (uintptr_t)p;
            if (flags & 1) { c->bufs[c->nbuf].p = p; c->bufs[c->nbuf].n = len; c->nbuf++; }
        } else if (kind == A_BLOCK) {
            /* Win64 passes structs larger than 8 bytes by reference */
            uint8_t nf = rb_u8(r);
            uint64_t *blk = call_alloc(c, (size_t)nf * 8);
            for (int f = 0; f < nf; f++) blk[f] = parse_scalar(r, c, rb_u8(r));
            c->a[i] = (uintptr_t)blk;
        } else {
            c->a[i] = parse_scalar(r, c, kind);
        }
    }
    return c;
}

static void exec_call(call_t *c, uint8_t resp_type)
{
    uint64_t rax = 0, xmm = 0;
    uint64_t *a = c->a;
    if (c->ret == R_DOUBLE) {
        double d = ((fn_dbl)c->fn)(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9], a[10], a[11]);
        memcpy(&xmm, &d, 8);
    } else {
        rax = ((fn_int)c->fn)(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9], a[10], a[11]);
    }

    wbuf w = {0};
    wb_begin(&w, resp_type);
    wb_u32(&w, c->req);
    wb_u64(&w, rax);
    wb_u64(&w, xmm);
    wb_u8(&w, (uint8_t)c->nbuf);
    for (int i = 0; i < c->nbuf; i++) {
        wb_u32(&w, c->bufs[i].n);
        wb_put(&w, c->bufs[i].p, c->bufs[i].n);
    }
    wb_u8(&w, (uint8_t)c->nret);
    for (int i = 0; i < c->nret; i++) wb_u64(&w, (uintptr_t)c->retained[i]);
    send_frame(&w);
    free(w.p);

    for (int i = 0; i < c->nalloc; i++) free(c->allocs[i]);
    free(c);
}

static DWORD WINAPI async_thread(void *arg)
{
    exec_call(arg, 0x84);
    return 0;
}

/* ---- request loop ----------------------------------------------------- */

static void send_resp(uint32_t req, uint64_t rax, uint64_t extra)
{
    wbuf w = {0};
    wb_begin(&w, 0x81);
    wb_u32(&w, req);
    wb_u64(&w, rax);
    wb_u64(&w, extra);
    wb_u8(&w, 0);
    wb_u8(&w, 0);
    send_frame(&w);
    free(w.p);
}

static void to_dos_path(char *p)
{
    for (; *p; p++) if (*p == '/') *p = '\\';
}

static void handle_frame(rbuf *r, LONG wait_id, int *done)
{
    uint8_t type = rb_u8(r);
    switch (type) {
    case 0x01: { /* LOAD */
        uint32_t req = rb_u32(r);
        char *unix_path = rb_bytes(r, NULL);
        char *path = malloc(strlen(unix_path) + 3);
        if (!path) die("out of memory");
        strcpy(path, "Z:");
        strcat(path, unix_path);
        to_dos_path(path);
        HMODULE h = LoadLibraryExA(path, NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
        send_resp(req, (uintptr_t)h, h ? 0 : GetLastError());
        free(path);
        free(unix_path);
        break;
    }
    case 0x02: { /* SYM */
        uint32_t req = rb_u32(r);
        HMODULE h = (HMODULE)(uintptr_t)rb_u64(r);
        char *name = rb_bytes(r, NULL);
        FARPROC p = GetProcAddress(h, name);
        send_resp(req, (uintptr_t)p, 0);
        free(name);
        break;
    }
    case 0x03: { /* CALL */
        uint8_t async;
        call_t *c = parse_call(r, &async);
        if (async) {
            HANDLE t = CreateThread(NULL, 0, async_thread, c, 0, NULL);
            if (!t) die("CreateThread failed");
            CloseHandle(t);
        } else {
            exec_call(c, 0x81);
        }
        break;
    }
    case 0x04: { /* CBREG */
        uint32_t req = rb_u32(r);
        uint8_t n = rb_u8(r);
        if (n > 4) die("callbacks with more than 4 arguments are not supported");
        uint8_t kinds[4] = {0};
        for (int i = 0; i < n; i++) kinds[i] = rb_u8(r);
        int slot = -1;
        EnterCriticalSection(&state_lock);
        for (int i = 0; i < MAX_CB; i++)
            if (!cbs[i].used) {
                cbs[i].used = 1;
                cbs[i].nargs = n;
                memcpy(cbs[i].kinds, kinds, 4);
                slot = i;
                break;
            }
        LeaveCriticalSection(&state_lock);
        send_resp(req, slot < 0 ? 0 : (uintptr_t)cb_table[slot], (uint64_t)(int64_t)slot);
        break;
    }
    case 0x05: { /* CBFREE */
        uint32_t req = rb_u32(r);
        void *p = (void *)(uintptr_t)rb_u64(r);
        EnterCriticalSection(&state_lock);
        for (int i = 0; i < MAX_CB; i++)
            if (cb_table[i] == p) cbs[i].used = 0;
        LeaveCriticalSection(&state_lock);
        send_resp(req, 0, 0);
        break;
    }
    case 0x07: { /* READ */
        uint32_t req = rb_u32(r);
        const void *p = (const void *)(uintptr_t)rb_u64(r);
        uint32_t len = rb_u32(r);
        wbuf w = {0};
        wb_begin(&w, 0x81);
        wb_u32(&w, req);
        wb_u64(&w, 0);
        wb_u64(&w, 0);
        wb_u8(&w, 1);
        wb_u32(&w, len);
        wb_put(&w, p, len);
        wb_u8(&w, 0);
        send_frame(&w);
        free(w.p);
        break;
    }
    case 0x08: { /* FREE */
        uint32_t req = rb_u32(r);
        free((void *)(uintptr_t)rb_u64(r));
        send_resp(req, 0, 0);
        break;
    }
    case 0x06: { /* CBDONE */
        LONG id = (LONG)rb_u32(r);
        if (id == wait_id) *done = 1;
        else pending_signal(id);
        break;
    }
    default:
        die("unknown frame type");
    }
}

static void serve_until(LONG wait_id)
{
    int done = 0;
    while (!done) {
        uint32_t len;
        recv_all(&len, 4);
        uint8_t *buf = malloc(len ? len : 1);
        if (!buf) die("out of memory");
        recv_all(buf, len);
        rbuf r = { buf, buf + len };
        handle_frame(&r, wait_id, &done);
        free(buf);
    }
}

int main(int argc, char **argv)
{
    if (argc < 3) {
        fprintf(stderr, "usage: nlbridge <port> <token>\n");
        return 2;
    }
    InitializeCriticalSection(&send_lock);
    InitializeCriticalSection(&state_lock);
    reader_tid = GetCurrentThreadId();

    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa)) die("WSAStartup failed");
    sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == INVALID_SOCKET) die("socket failed");
    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_port = htons((u_short)atoi(argv[1]));
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(sock, (struct sockaddr *)&addr, sizeof addr)) {
        fprintf(stderr, "[nlbridge] connect to port %s failed: WSA error %d\n", argv[1], WSAGetLastError());
        die("connect failed");
    }
    BOOL one = TRUE;
    setsockopt(sock, IPPROTO_TCP, TCP_NODELAY, (const char *)&one, sizeof one);

    wbuf w = {0};
    wb_begin(&w, 0x83);
    uint32_t n = (uint32_t)strlen(argv[2]);
    wb_u32(&w, n);
    wb_put(&w, argv[2], n);
    send_frame(&w);
    free(w.p);

    serve_until(0); /* call ids start at 1, so this never returns */
    return 0;
}
