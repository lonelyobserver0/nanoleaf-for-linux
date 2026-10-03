# Nanoleaf Desktop per Linux

Porting non ufficiale di [Nanoleaf Desktop](https://nanoleaf.me/en-US/integration/desktop-app/) su Linux.
Il build parte dall'installer Windows ufficiale e non ridistribuisce nulla di Nanoleaf.

## Come funziona

Nanoleaf Desktop è un'app Electron. Quasi tutto (UI Angular, discovery mDNS,
OpenAPI HTTP, CoAP, MQTT) è JavaScript e gira su Linux così com'è. I pezzi
legati a Windows sono:

| Componente | Soluzione |
|---|---|
| Electron Windows | Electron Linux della stessa versione |
| `usb`, `node-hid` | Addon Linux ufficiali da npm |
| `koffi` (FFI) + 9 DLL proprietarie | **Shim koffi + bridge Wine** (vedi sotto) |
| Updater (electron-updater) | Disattivato (`--skip-update`): si aggiorna ricostruendo |

### Bridge Wine

Le DLL di Nanoleaf fanno solo calcolo e usano solo il CRT (protocolli ECL/LTPDUv3,
motori effetti, calibrazione colore, firme Shazam), quindi Wine le carica senza
problemi. Electron invece sotto Wine non parte.

```
Electron (Linux)                               Wine
┌──────────────────────────┐   TCP localhost   ┌────────────────────────┐
│ main.js originale        │   + token         │ nlbridge.exe.so        │
│   └ koffi  ──► shim/     │ ◄───────────────► │  LoadLibrary(libX.dll) │
│     koffi-shim.cjs       │                   │  chiamate ms_abi       │
│     (worker + Atomics)   │                   │  64 stub per callback  │
└──────────────────────────┘                   └────────────────────────┘
```

- `shim/loader.mjs` è il nuovo `main` del package. Al `require` di `koffi.node`
  risponde con lo shim, poi importa il bundle originale senza modifiche.
- `shim/koffi-shim.cjs` implementa l'API nativa di koffi usata dall'app
  (`load`, `func`, `.async`, `proto`, `struct`, `register`, `unregister`).
  Fa il parsing delle firme C, gestisce i buffer con copia di ritorno e le
  callback rientranti, e mantiene la semantica dei thread di koffi.
- `shim/screen-mirror.cjs` reimplementa `libScreenMirror.dll` (vedi sotto).
- `shim/audio.cjs` reimplementa `libAudio.dll` per il music sync (vedi sotto).
- `shim/stubs.cjs` contiene Razer Chroma, che risponde "niente disponibile".
- `scripts/patch-bundle.cjs` applica le poche modifiche al bundle che non si
  possono fare dall'esterno. Ogni patch deve fare match esattamente una volta,
  altrimenti il build si ferma.
- `helper/nlbridge.c` è un programma winelib compilato con `winegcc`.

### Screen Mirror

Su Linux l'app usa il backend "legacy" (quello della DLL), che qui è riscritto in JS:

- **Cattura** (`shim/screen-capture.cjs`): prima prova il portal ScreenCast
  (PipeWire, funziona su GNOME, KDE e Hyprland con `xdg-desktop-portal-hyprland`).
  Se manca, ripiega su `grim` (wlr-screencopy) a 8 fps, senza selettore.
  `NANOLEAF_CAPTURE=portal|grim` forza un backend.
- **Analisi** (`shim/mirror-colors.cjs`): frame ridotto a 96 px di larghezza;
  - 4D: ogni pannello prende la zona di schermo davanti a sé;
  - Tranquility: colore dominante (k-means) smussato, uguale su tutti i pannelli;
  - Flow: il colore dominante entra da sinistra e scorre sui pannelli;
  - Chameleon: la palette dello schermo distribuita sui pannelli.
  La palette serve anche all'Orchestrator.
- **Uscita**: lo stesso JSON `animData` della DLL. L'invio UDP ai dispositivi lo fa l'app.

### Music sync

`libAudio.dll` cattura l'audio di sistema o di una singola app (WASAPI). Su
Linux lo fa PipeWire con `pw-record --raw` (f32, 48 kHz, stereo, latenza 20 ms):

- sorgente **All system audio**: il monitor dell'uscita predefinita;
- una sorgente per ogni **app che sta suonando** (da `pw-dump`), identificata dal nome
  del binario, che resta stabile tra un riavvio e l'altro. `pw-record` parte senza
  collegamenti, e ogni secondo **tutti** gli stream di uscita dell'app vengono collegati
  al suo ingresso con `pw-link`, dove PipeWire li mixa. Serve perché Firefox, ad esempio,
  apre più stream e ne crea di nuovi per ogni tab o video.

L'app abilitava la cattura solo su macOS ≥ 13 e Windows ≥ 22H2: `patch-bundle.cjs`
aggiunge Linux a quel controllo.

## Build

Dipendenze: `wine`, `7z` (p7zip), `node`/`npm`, `make`, `winegcc` (incluso in wine).
A runtime: `pipewire` (`pw-record`, `pw-dump`), e `grim` o un portal ScreenCast per lo Screen Mirror.

```sh
scripts/build.sh "Nanoleaf Desktop Setup 3.0.0.exe"
dist/nanoleaf-desktop/nanoleaf-desktop
```

Il primo avvio crea un prefix Wine dedicato in `~/.local/share/nanoleaf-linux/wine`
(qualche secondo). Agli avvii successivi il bridge è pronto in circa 0,4 s.

Variabili utili:

- `NANOLEAF_SHIM_DEBUG=1`: log dello shim e log dell'app su stdout
- `NANOLEAF_WINE`, `NANOLEAF_WINEPREFIX`, `NANOLEAF_BRIDGE_HELPER`: override

## Test

```sh
make -C helper
node test/smoke.cjs build/work/win/resources/app/lib/win32-x64
node test/screen-mirror.cjs                                  # analisi colori, schermo sintetico
node test/audio.cjs                                          # cattura PipeWire (fai suonare qualcosa)
build/electron-*/dist/electron test/capture-electron.cjs     # cattura vera (portal o grim)
```

## Stato

- [x] Avvio, UI, discovery dispositivi
- [x] Tutte le DLL di calcolo caricate sotto Wine
- [ ] Verifica su dispositivi reali: pairing, controllo, effetti (MotionPlayer), LTPDUv3
- [x] Screen Mirror: cattura portal/grim e le 4 modalità
- [x] Screen Mirror provato sulle Light Panels (NL22)
- [x] Music sync: cattura PipeWire (sistema o singola app)
- [x] Music sync provato sulle Light Panels (sistema, Desktop, singola app)
- [ ] Pacchetto (AUR / AppImage), file `.desktop`
