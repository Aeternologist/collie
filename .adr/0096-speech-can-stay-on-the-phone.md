# 0096: Speech can stay on the phone: a vendored engine in a worker with its own policy, a model the host holds on purpose

- **Status:** Proposed
- **Date:** 2026-10-11
- **Shipped in:** pending (1.20.0, with the voice takeover)
- **Amends in scope:** [ADR 0029](./0029-speech-to-text-is-a-provider-seam-collie-owns.md), whose
  *What would justify revisiting* names this case: "an on-device transcription path good enough on
  a phone". The provider seam, the setup-is-a-CLI-act rule, the lead-only rule and the hands-free
  rule all stand. This adds a second engine beside the seam, and retracts nothing. On acceptance,
  0029 gains the `Amended in scope by 0096` pointer.
- **Relates to:** [ADR 0033](./0033-the-app-face-is-a-device-preference.md) (the engine is a
  per-device preference, stored the way the typeface is) ·
  [ADR 0034](./0034-collie-collects-nothing-and-opt-in-is-the-ceiling.md) (the phone calls no third
  party) · [ADR 0086](./0086-reads-need-the-pairing-token.md) (the model is a read, so it needs the
  token) · [ADR 0019](./0019-oxlint-and-vendored-anti-slop-are-the-lint-gate.md) (vendored code is
  re-pinned by a person who reads the diff) · [ADR 0052](./0052-one-build-serves-any-mount.md) (the
  worker finds its files relative to itself) · [ADR 0087](./0087-the-on-device-store-is-one-thing.md)
  (the model is an asset, not session content, so it does not go in `collie-store`).
- **Trail:** ADR 0029 § *What would justify revisiting* · `docs/voice-and-push.md` → *Quick start:
  Cactus Whistle on this machine* (e99ad833, the host path this builds on) · the 2026-10-11 Pixel 10a
  measurement (below) · the roads argued against below: Altan's call against bundling the model in
  every release (2026-10-11), "just load it from Hugging Face", and "add `'wasm-unsafe-eval'` to the
  CSP" · planned reach: `web/public/stt/needle-<version>/` (vendored `needle.js`, `needle.wasm`,
  `LICENSE`, `PROVENANCE.md`) · `web/src/stt/worker.ts` · `web/src/lib/stt-engine.ts` ·
  `web/src/lib/stt-pcm.ts` · `web/src/lib/stt-model.ts` · `web/src/lib/stt.ts` ·
  `web/src/hooks/use-stt-recorder.ts` · `web/src/sw.ts` · `web/src/lib/pwa.ts` · `web/vite.config.ts` ·
  `bridge/server.ts` (`STT_WORKER_CSP`, `serveStatic`, the model route, `/api/config`) ·
  `bridge/stt/whistle-model.ts` · `cli/stt.ts` (`stt whistle`) · `CLAUDE.md` → *Security posture*

## Context

ADR 0029 let speech in through the host. The phone records webm/opus (Chrome) or mp4/AAC (Safari),
uploads it to `POST /api/stt`, and the bridge hands it to a provider the operator configured: a cloud
endpoint, the operator's Codex login, or a local command. Each one costs something: a key in the
state dir, room audio leaving the host, or a child process. The local command is the cheapest, and
since e99ad833 the docs walk an operator to Cactus Whistle on the host in four steps.

What changed is that a speech model now runs well **on the phone itself**. Measured 2026-10-11:

- **The model.** Whistle (`Cactus-Compute/whistle`), one file, `whistle.cact`, 16,919,407 bytes,
  sha256 `b6e02f04…1dffeb`. Apache-2.0 per its model card and the `LICENSE` file beside it. No
  `NOTICE` file. Its training data is not disclosed. Seven languages: en, de, fr, es, it, nl, pl.
- **The engine.** `needle` (`Cactus-Compute/needle3`, folder `wasm/`): `needle.js`, 63 KB of
  Emscripten glue, and `needle.wasm`, 929 KB (340 KB gzipped). Single-threaded, so no
  `SharedArrayBuffer` and no COOP/COEP. The glue is a classic script that defines one global,
  `createNeedle`. A static read of it at commit `93e88ede` finds no `eval` and no `new Function`;
  its only network use is a `fetch` of the `.wasm` when no `wasmBinary` is passed, and a synchronous
  XHR for lazy files, which nothing here asks for. The wasm imports sixteen functions: C++ throw,
  abort, file, clock, environment and heap calls, nothing else.
- **The speed.** Pixel 10a, Chrome 154, inside a Web Worker: a 10.4 s clip in 1.0 to 1.1 s, a 13.0 s
  clip in about 0.8 s, 0.1 s to start. The wasm heap is about 67 MB. A desktop is the same order.
- **The cost of the bytes.** 18 MB from the bridge over the tailnet took 29 s.

So the condition 0029 named is met. On a recent phone, speech can become text with no upload, no
provider, no key, no child process and no audio off the phone. On a weak phone it cannot, and the
host engine stays the right answer there. **Both are first-class**, and neither replaces the other.

Three things make this harder than "add a library":

1. **The engine is third-party code running in Collie's origin.** That origin holds the pairing
   token and can type into real terminals (`CLAUDE.md`: treat a collie as remote shell access). A
   wasm binary cannot be reviewed by reading it the way the vendored lint plugin can.
2. **WebAssembly needs a CSP grant.** The document's policy is `script-src 'self'`, and Chrome refuses to
   compile wasm under it without `'wasm-unsafe-eval'` (WebKit is treated as refusing too). Granting that to the
   document grants it to every script on every page.
3. **17 MB is real.** Not gigantic, but too much to put on every install, and too much to fetch
   behind anyone's back.

## Decision

**A person may choose, per device, to turn speech into text on the phone. The engine code ships
inside Collie, vendored at a pinned version, and runs only in a dedicated worker whose own response
carries the one CSP that allows wasm. The model reaches the host by an explicit CLI act and the phone
by an explicit tap, never by itself and never from a third party. The transcript lands where every
transcript lands.**

1. **Two engines, one device preference.** Settings → Speech gets *Speech engine: Host / This
   phone*. *Host* is today's providers, unchanged, and is the default. *This phone* runs Whistle in
   the browser. The value lives in `localStorage` per device, like the typeface (ADR 0033), because
   whether a phone is strong enough is a fact about that phone. A wipe (lib/wipe.ts) keeps it: it is
   a preference, not session content.

2. **Both placements are deliberate acts.** Nothing about Whistle happens by itself.
   - **On the host, one CLI verb:** `collie stt whistle`. With `--phones` it fetches the pinned model
     into the state dir and offers it to phones. With `--host` it also fetches the pinned `needle`
     runner for this platform, writes the wrapper, and configures the `local-cli` provider (it asks
     first when another provider is configured). Both flags may be given. With neither and a
     terminal, it asks; with neither and no terminal, it refuses and writes nothing.
     `collie stt whistle --remove` deletes what it fetched. Every file is checked against a sha256
     pinned in Collie's source before it is kept, and written by temp file plus rename.
   - **The host may hold the model for phones without running the host engine.** That is the common
     case for a strong phone, and it costs the host nothing at rest: no provider, no child, no egress
     after the one download, only bytes on disk that the bridge serves on request.
   - **On the phone, one tap:** *Download speech model (16.9 MB)* in Settings, offered only when the
     host holds the model. No phone ever fetches it unasked, not on install, not on an update, not
     when the preference is set.

3. **The bridge downloads nothing.** The CLI fetches, in the operator's shell, from a pinned
   Hugging Face commit URL (`resolve/<commit>/whistle.cact`), with an honest `User-Agent`, a size cap
   and the sha256 check. `--from <path>` takes a file the operator already has (the quick start's
   copy, an air-gapped transfer) through the same check. The bridge only reads its own file and
   serves it. The sentence in `CLAUDE.md` *the bridge makes no outbound call … unless the operator
   ran `collie stt setup`* stays true as written; it gains `collie stt whistle` as the second CLI act
   that may fetch, and the bridge itself gains no outbound path.

4. **The model is never in a release artifact.** Altan's call, 2026-10-11: 17 MB is large for an
   install that may never use it, and Collie does not know its operators' links or disks. The engine
   code (about 1 MB) does ship in every release, because the phone may load code from Collie's own
   build and nowhere else.

5. **The engine code is vendored, pinned and read.** `web/public/stt/needle-<version>/` holds
   `needle.js` and `needle.wasm` byte for byte as upstream published them at one commit, plus
   upstream's `LICENSE` and a `PROVENANCE.md` (source URL, commit, sha256 of each file, the date).
   A test pins both hashes and the wasm's import list. Re-vendoring is a maintainer's commit, never a
   bot's, and the diff gets a human read (ADR 0019's rule). Because a wasm binary cannot be read, the
   read covers what can be: the glue's diff, the header's diff, and **the import list, which is
   everything the wasm can ask its host to do.** A new import is a reason to stop. The files sit in
   `public/` so Vite copies them untouched and the served bytes are the hashed bytes.

6. **The phone never loads code or data from a third party.** No CDN, no Hugging Face, no fallback
   URL. The engine comes from Collie's own static files, the model from the bridge.

7. **The wasm runs in a dedicated worker, and only the worker's response grants wasm.** The
   document CSP does not change and never gains `'wasm-unsafe-eval'`. The worker script is our own
   code, built by Vite as a classic worker to `stt/worker-<hash>.js`, and it loads the glue with
   `importScripts` relative to its own URL (so a mount works, ADR 0052). The bridge serves every
   `.js` under `stt/` with:

   ```
   Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; base-uri 'none'
   ```

   Under CSP Level 3 a dedicated worker loaded from a URL runs under the policy its own response
   carries, not its creator's. Chrome has done so since October 2021 (Chromium "[CSP] Fix dedicated
   worker inheritance"), and WebKit since January 2016 (bug 153157, r195948; `Worker.cpp` today takes
   the response's headers for every worker that is not `blob:`, `file:` or opaque). A worker made
   from a `blob:` URL inherits the document's policy, so the worker is never a blob.
   - **The worker has no network.** `default-src 'none'` covers `connect-src`, so the glue cannot
     fetch, XHR or open a socket, and `importScripts` reaches only Collie's origin. The page fetches
     the wasm and the model, checks both hashes, and transfers the bytes in. The glue's own `fetch`
     of the wasm never runs, because `wasmBinary` is always passed.
   - **The worker cannot read the pairing token**, which lives in `localStorage`, which workers do
     not have. It can reach IndexedDB and Cache Storage, which no CSP directive closes. That residue
     is accepted and named under *Consequences*.
   - **Fail closed.** When the worker starts, it compiles an eight-byte wasm module before anything
     else. A browser that does not give the worker its own policy, or does not know
     `'wasm-unsafe-eval'`, refuses that compile, and *This phone* shows as unavailable on that
     browser with a reason. The fallback is the Host engine. The fallback is **never** a wider
     document policy.

8. **The model is a content-addressed read.** `GET /api/stt/model/<sha256>` on the lead. A plain read:
   it needs the pairing token (ADR 0086) and nothing more, because the bytes are public and asking
   for them changes nothing. It answers the file only when the hash in the path equals the hash of
   the file the bridge holds. The hash is compared, never joined into a path, so this is not a fifth
   place where a client value becomes a path. `content-type: application/octet-stream`,
   `content-length`, `etag` set to the hash, `cache-control: no-store` (the phone keeps its own
   copy, and the HTTP cache should not keep a second one), `content-security-policy: default-src
   'none'; sandbox`, no gzip, and no ranges. `/api/config` carries `sttPhone: { engine, sha256,
   bytes }` only while the bridge holds a model whose hash matches a pin this release accepts. The
   key is omitted otherwise, the same omit-when-absent rule `stt` follows. The bridge hashes the file
   once per change of its size or mtime, not per request.

9. **The phone checks the hash, keeps the copy, and asks to keep it.** The model is stored in Cache
   Storage under a cache of its own, only after its sha256 matched the capability. The page hashes it
   again once per page session before the first load, and the worker checks the wasm's hash before
   it compiles. The download asks `navigator.storage.persist()` and says what the answer means. The
   stuck-update recovery in `lib/pwa.ts`, which deletes every cache, skips this one by name: a
   stale model cannot cause a stale app. The pairing wipe takes it with everything else in Cache
   Storage: it was fetched with the token, so it leaves with the token.

10. **The transcript lands through `acceptTranscript`.** Same caret insert, same hands-free rules
    (an empty draft, no password prompt, no dialog, online, not locked). On this engine the audio
    never leaves the phone, so `POST /api/stt` is not called and nothing is audited on the bridge.

11. **No silent switch between engines.** When *This phone* cannot transcribe a clip (no model, a
    hash mismatch, a crash, out of memory, a timeout), the takeover says why and offers *Send to
    host* as one tap, only while the host has an available provider. It never sends the audio to
    the host by itself, because the person chose an engine whose point is that audio stays put.

## Consequences

- **Third-party code runs in Collie's origin.** Its reach is bounded, not removed. The worker has no
  network, no DOM, no token and no way to load code from elsewhere. It can still read and write this
  origin's IndexedDB (`collie-store` holds recent session text, ADR 0087) and Cache Storage, and it
  can hand back any text it likes. With hands-free on, that text is sent into a terminal through the
  guarded reply path. That is the same trust a host provider's answer already gets. What limits it
  here is the pin, the read of each bump, and a worker that cannot send anything out.
- **About 1 MB more in every release** (63 KB glue, 929 KB wasm), and about 1 MB more in git per
  engine bump. It is not precached: `stt/**` is in the precache's ignore list, the way the Nerd Font
  subsets are, and the service worker caches it cache-first under its own name only after the
  person downloaded the model, so that the engine also works offline.
- **The phone needs a 17 MB download per device**, about 30 s over a tailnet, restarted from zero if
  it breaks. No resume: Cache Storage keeps whole responses only, and a resume would need a partial
  store, a second validator and range handling on the bridge, for one file fetched once.
- **Pinned pairs drift.** Upstream replaced `needle.wasm` on 2026-10-10 and left `needle.js` from
  2026-10-05. The pin is the pair, tested together, and a bump that moves one file and not the other
  is read twice.
- **A host may hold a model that this release no longer accepts.** After an update with a new pin,
  `sttPhone` disappears until the operator runs `collie stt whistle` again. `collie stt status` and
  `collie doctor` say so in words. A pin bump keeps the previous hash in the accepted list unless the
  engine cannot read the old file.
- **WebKit is checked in a WebKit build, not on an iPhone.** The maintainer has none. The `wk`
  distrobox and CI's WebKit run cover the worker policy, the wasm compile and the decode path. iOS on
  a device stays unverified until someone reports it.
- **`collie stt whistle --host` downloads a native executable** for this platform, pinned by sha256.
  That runs as the bridge user with no sandbox, unlike the wasm. It needs `ffmpeg` and `jq` on the
  host (the quick start's wrapper), it is Linux and macOS only, and a downloaded glibc binary does not
  run on NixOS. On Windows and NixOS the verb refuses `--host` with a sentence and still serves
  `--phones`.

### Alternatives considered

- **Bundle the model in every release.** One step less for the operator, and the phone engine works
  on day one. Rejected by Altan on 2026-10-11: everyone pays 17 MB for a feature some will never
  turn on, on links and disks Collie knows nothing about.
- **The phone fetches the model, or the engine, from Hugging Face.** No host step at all. Rejected:
  it makes the phone a client of a third party (ADR 0034), it needs a CSP hole for that origin, and
  the bytes would arrive from somewhere the operator never chose. A hash check fixes integrity, not
  any of that.
- **`'wasm-unsafe-eval'` in the document CSP.** One line, and the engine could run anywhere. Rejected:
  it widens the policy of the page that holds the token and drives terminals, for code that needs it
  in one place.
- **A `blob:` worker, or the engine on the main thread.** A blob worker inherits the document's
  policy, so it needs the same hole. The main thread would also freeze the UI for a second per clip.
- **A sandboxed iframe around the worker**, so the engine gets an opaque origin with no IndexedDB
  and no Cache Storage. A real gain against the residue named above. Not now: it needs a second
  document, a `frame-src` grant, and a blob worker inside the frame, and the measured design works
  without it. It is the first hardening step to take if the residue starts to matter.
- **The bridge downloads the model on first request.** Seamless, and it breaks "the bridge makes no
  outbound call". A CLI act keeps the download in the operator's shell, where they see it.
- **Reuse the quick start's file automatically.** It sits outside the state dir, at a path the
  operator chose, and Collie does not go looking. `--from <path>` takes it on purpose.
- **Browser `SpeechRecognition`.** Still rejected for ADR 0029's reason: on the phones that matter it
  is absent, or it ships the audio to the browser vendor.
- **Silent fallback to the host on failure.** Kinder in the moment, and wrong: it would move audio
  off the phone without the person's word.

### What would justify revisiting

- **A browser that will not give a dedicated worker its own policy**, and matters. Then the
  sandboxed frame above, not the document policy.
- **Evidence that the IndexedDB and Cache Storage reach is being used**, or a bump whose import list
  grows. Then the sandboxed frame, at once.
- **Upstream publishing a signed release** (a tag with signatures, or a package with provenance).
  The pin could then follow a signature as well as a hash.
- **The host engine moving to the same wasm.** The bridge could run the vendored engine in a Bun
  worker and take 16 kHz WAV from a phone that already converts it. That would remove the native
  download, `ffmpeg`, `jq` and the platform list, and serve Windows and NixOS. It is a provider of
  its own, and it is not decided here.
