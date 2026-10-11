import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WHISTLE_MODEL } from "./whistle-pins.ts";
import {
  createWhistleModelStore,
  resetWhistleModelState,
  whistleEngineDir,
  whistleEngineInPlace,
  whistlePaths,
  type WhistleFetch,
  type WhistleModelPin,
} from "./whistle-model.ts";

// No network: every download here is served by a fake fetch, from bytes the test made up and pinned.

const MODEL = new TextEncoder().encode("a tiny stand-in for whistle.cact, 40+ bytes long");
const SHA = createHash("sha256").update(MODEL).digest("hex");
const PIN: WhistleModelPin = { url: "https://models.invalid/whistle.cact", revision: "rev1", sha256: SHA, bytes: MODEL.byteLength };

let stateDir: string;
beforeEach(() => {
  resetWhistleModelState();
  stateDir = mkdtempSync(join(tmpdir(), "collie-whistle-model-"));
});
afterEach(() => {
  resetWhistleModelState();
  rmSync(stateDir, { recursive: true, force: true });
});

/** A fetch that answers `body` in `chunks` pieces and records every call. */
function fakeFetch(body: Uint8Array = MODEL, opts: { status?: number; chunks?: number; length?: number | null; gate?: Promise<void> } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn: WhistleFetch = async (url, init) => {
    calls.push({ url, init });
    await opts.gate;
    const pieces = opts.chunks ?? 3;
    const size = Math.ceil(body.byteLength / pieces);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < body.byteLength; i += size) controller.enqueue(body.slice(i, i + size));
        controller.close();
      },
    });
    const headers: Record<string, string> = {};
    const length = opts.length === undefined ? body.byteLength : opts.length;
    if (length !== null) headers["content-length"] = String(length);
    return new Response(stream, { status: opts.status ?? 200, headers });
  };
  return { fn, calls };
}

function store(fetchImpl: WhistleFetch, extra: { capBytes?: number; pin?: WhistleModelPin } = {}) {
  return createWhistleModelStore({ stateDir, version: "1.20.0", fetch: fetchImpl, pin: extra.pin ?? PIN, accepted: [SHA], capBytes: extra.capBytes, now: () => Date.UTC(2026, 9, 11) });
}

describe("the Whistle model store", () => {
  test("absent at first, with the pinned size always present", async () => {
    const s = store(fakeFetch().fn);
    expect(await s.status()).toEqual({ state: "absent", bytes: MODEL.byteLength });
    expect(await s.ready()).toBeNull();
  });

  test("a download lands the file at 0600 in a 0700 folder, with a manifest, and reads ready", async () => {
    const f = fakeFetch();
    const s = store(f.fn);
    const start = await s.start();
    expect(start.outcome).toBe("downloading");
    await s.settled();

    const paths = whistlePaths(stateDir);
    expect(readFileSync(paths.model)).toEqual(Buffer.from(MODEL));
    expect(existsSync(paths.part)).toBe(false);
    if (process.platform !== "win32") {
      expect(statSync(paths.dir).mode & 0o777).toBe(0o700);
      expect(statSync(paths.model).mode & 0o777).toBe(0o600);
      expect(statSync(paths.manifest).mode & 0o777).toBe(0o600);
    }
    expect(await s.status()).toEqual({ state: "ready", bytes: MODEL.byteLength, sha256: SHA });
    expect(await s.ready()).toEqual({ path: paths.model, sha256: SHA, bytes: MODEL.byteLength });
    expect(await s.manifest()).toEqual({
      version: 1,
      model: { sha256: SHA, bytes: MODEL.byteLength, revision: "rev1", source: PIN.url, fetchedAt: "2026-10-11T00:00:00.000Z" },
    });
  });

  test("the request goes to the pinned URL, follows redirects, and says who it is", async () => {
    const f = fakeFetch();
    const s = store(f.fn);
    await s.start();
    await s.settled();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(PIN.url);
    expect(f.calls[0]!.init.redirect).toBe("follow");
    expect(new Headers(f.calls[0]!.init.headers).get("user-agent")).toBe("Collie/1.20.0");
  });

  test("the production pin is the Hugging Face commit URL", () => {
    expect(WHISTLE_MODEL.url).toBe(`https://huggingface.co/Cactus-Compute/whistle/resolve/${WHISTLE_MODEL.revision}/whistle.cact`);
  });

  test("a hash mismatch keeps nothing, and reports both hashes", async () => {
    const wrong = new TextEncoder().encode("not the pinned bytes at all, but the same idea");
    const s = store(fakeFetch(wrong).fn);
    await s.start();
    await s.settled();
    const paths = whistlePaths(stateDir);
    expect(existsSync(paths.model)).toBe(false);
    expect(existsSync(paths.part)).toBe(false);
    const status = await s.status();
    expect(status.state).toBe("failed");
    expect(status.reason).toContain(SHA);
    expect(status.reason).toContain(createHash("sha256").update(wrong).digest("hex"));
    expect(status.reason).not.toContain(stateDir);
  });

  test("the size cap stops a body that runs past it, declared or not", async () => {
    const big = new Uint8Array(4096);
    for (const length of [4096, null]) {
      resetWhistleModelState();
      const s = store(fakeFetch(big, { length, chunks: 8 }).fn, { capBytes: 1024 });
      await s.start();
      await s.settled();
      const status = await s.status();
      expect(status.state).toBe("failed");
      expect(status.reason).toContain("larger than");
      expect(existsSync(whistlePaths(stateDir).part)).toBe(false);
    }
  });

  test("an HTTP error and a network error each fail with a short reason", async () => {
    const s = store(fakeFetch(MODEL, { status: 404 }).fn);
    await s.start();
    await s.settled();
    expect((await s.status()).reason).toBe("the download answered HTTP 404");

    resetWhistleModelState();
    const broken = store(async () => {
      throw new TypeError("getaddrinfo ENOTFOUND huggingface.co");
    });
    await broken.start();
    await broken.settled();
    expect((await broken.status()).reason).toBe("the download could not reach Hugging Face");
  });

  test("single flight: two starts while one runs make one request, and the second joins", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const f = fakeFetch(MODEL, { gate });
    const a = store(f.fn);
    const b = store(f.fn);
    const [first, second] = await Promise.all([a.start(), b.start()]);
    expect(first.outcome).toBe("downloading");
    expect(second.outcome).toBe("downloading");
    expect((await a.status()).state).toBe("downloading");
    open();
    await a.settled();
    expect(f.calls).toHaveLength(1);
    expect((await b.status()).state).toBe("ready");
  });

  test("idempotent when ready: a start fetches nothing", async () => {
    const f = fakeFetch();
    const s = store(f.fn);
    await s.start();
    await s.settled();
    const again = await s.start();
    expect(again.outcome).toBe("ready");
    expect(f.calls).toHaveLength(1);
  });

  test("a held file this build does not accept reads failed, and a start replaces it", async () => {
    const paths = whistlePaths(stateDir);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.model, "an older model");
    const f = fakeFetch();
    const s = store(f.fn);
    expect((await s.status()).state).toBe("failed");
    expect(await s.ready()).toBeNull();
    await s.start();
    await s.settled();
    expect((await s.status()).state).toBe("ready");
  });

  test("the hash is computed once per change of the file, not per ask", async () => {
    const s = store(fakeFetch().fn);
    await s.start();
    await s.settled();
    const paths = whistlePaths(stateDir);
    // Whole seconds, so the restored mtime is exactly the one that was hashed.
    utimesSync(paths.model, 1_700_000_000, 1_700_000_000);
    expect((await s.ready())?.sha256).toBe(SHA);
    // Same size, same mtime, same inode: a changed body is NOT re-read. This is the cache, observed.
    writeFileSync(paths.model, new Uint8Array(MODEL.byteLength).fill(65));
    utimesSync(paths.model, 1_700_000_000, 1_700_000_000);
    expect((await s.ready())?.sha256).toBe(SHA);
    writeFileSync(paths.model, "different length now");
    expect(await s.ready()).toBeNull();
  });

  test("a symlink at the model's path is refused, never followed", async () => {
    if (process.platform === "win32") return;
    const paths = whistlePaths(stateDir);
    mkdirSync(paths.dir, { recursive: true });
    const target = join(stateDir, "elsewhere.cact");
    writeFileSync(target, MODEL);
    symlinkSync(target, paths.model);
    const s = store(fakeFetch().fn);
    expect((await s.status()).state).toBe("failed");
    expect(await s.ready()).toBeNull();
    const start = await s.start();
    expect(start.outcome).toBe("refused");
    expect(lstatSync(paths.model).isSymbolicLink()).toBe(true);
    expect(readFileSync(target)).toEqual(Buffer.from(MODEL));
  });

  test("a symlinked folder is refused before anything is fetched", async () => {
    if (process.platform === "win32") return;
    const away = mkdtempSync(join(tmpdir(), "collie-whistle-away-"));
    symlinkSync(away, join(stateDir, "whistle"));
    const f = fakeFetch();
    const s = store(f.fn);
    const start = await s.start();
    expect(start).toMatchObject({ outcome: "refused" });
    expect(f.calls).toHaveLength(0);
    expect(readdirSync(away)).toEqual([]);
    rmSync(away, { recursive: true, force: true });
  });

  test("a stale part file left by a crash is replaced, and a symlink there is refused", async () => {
    const paths = whistlePaths(stateDir);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.part, "half a model");
    // A crash's: older than the deadline.
    const old = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(paths.part, old, old);
    const s = store(fakeFetch().fn);
    await s.start();
    await s.settled();
    expect((await s.status()).state).toBe("ready");

    if (process.platform === "win32") return;
    await s.remove();
    symlinkSync(join(stateDir, "victim"), paths.part);
    const again = await s.start();
    expect(again.outcome).toBe("refused");
    expect(existsSync(join(stateDir, "victim"))).toBe(false);
  });

  test("the model lives in <stateDir>/whistle/, one level down, and nothing is made under stt/", async () => {
    const s = store(fakeFetch().fn);
    await s.start();
    await s.settled();
    expect(whistlePaths(stateDir).dir).toBe(join(stateDir, "whistle"));
    expect(readdirSync(stateDir)).toEqual(["whistle"]);
    expect(readdirSync(join(stateDir, "whistle")).toSorted()).toEqual(["whistle.cact", "whistle.json"]);
  });

  test("a part file younger than the deadline is another process's download: nothing is fetched or touched", async () => {
    const paths = whistlePaths(stateDir);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.part, "half of it");
    const f = fakeFetch();
    const s = store(f.fn);
    // Its size is what the other process has received so far.
    expect(await s.status()).toEqual({ state: "downloading", bytes: MODEL.byteLength, received: 10 });
    const start = await s.start();
    expect(start).toEqual({ outcome: "downloading", elsewhere: true, status: { state: "downloading", bytes: MODEL.byteLength, received: 10 } });
    expect(f.calls).toHaveLength(0);
    expect(readFileSync(paths.part, "utf8")).toBe("half of it");
    await s.settled();
    // The other process finishing (the file renamed away) ends it.
    rmSync(paths.part);
    expect((await s.status()).state).toBe("absent");
  });

  test("a part file at the deadline's edge is stale, and the next start replaces it", async () => {
    const paths = whistlePaths(stateDir);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.part, "ancient");
    const f = fakeFetch();
    const s = createWhistleModelStore({ stateDir, version: "1.20.0", fetch: f.fn, pin: PIN, accepted: [SHA], timeoutMs: 60_000 });
    const old = new Date(Date.now() - 61_000);
    utimesSync(paths.part, old, old);
    expect((await s.status()).state).toBe("absent");
    expect((await s.start()).outcome).toBe("downloading");
    await s.settled();
    expect((await s.status()).state).toBe("ready");
    expect(f.calls).toHaveLength(1);
  });

  test("the part file is created before the request, so a second process sees the lock while the first connects", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fakeFetch(MODEL, { gate });
    const first = store(f.fn);
    await first.start();
    expect(existsSync(whistlePaths(stateDir).part)).toBe(true);
    // The file is the lock a second process sees, and it is fresh.
    expect(Date.now() - statSync(whistlePaths(stateDir).part).mtimeMs).toBeLessThan(10_000);
    release();
    await first.settled();
    expect((await first.status()).state).toBe("ready");
  });

  test("remove deletes the model, the manifest and the part, and stops a download in flight", async () => {
    const s = store(fakeFetch().fn);
    await s.start();
    await s.settled();
    expect(await s.remove()).toEqual({ state: "absent", bytes: MODEL.byteLength });
    const paths = whistlePaths(stateDir);
    expect(existsSync(paths.model)).toBe(false);
    expect(existsSync(paths.manifest)).toBe(false);

    // A download stopped by a removal is not a failure.
    const stalled = new Promise<void>(() => undefined);
    const slow = createWhistleModelStore({
      stateDir,
      version: "1.20.0",
      pin: PIN,
      accepted: [SHA],
      fetch: async (_url, init) => {
        await Promise.race([stalled, new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))]);
        throw new Error("unreachable");
      },
    });
    await slow.start();
    expect((await slow.status()).state).toBe("downloading");
    expect(await slow.remove()).toEqual({ state: "absent", bytes: MODEL.byteLength });
  });
});

describe("the engine files", () => {
  test("the served copy is preferred, and the vendored copy is the source-mode fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "collie-whistle-root-"));
    const vendored = whistleEngineDir(root);
    expect(vendored).toContain(join("web", "public", "stt"));
    expect(whistleEngineInPlace(root)).toBe(false);
    const served = vendored.replace(join("web", "public"), join("web", "dist"));
    mkdirSync(served, { recursive: true });
    writeFileSync(join(served, "needle.js"), "x");
    expect(whistleEngineDir(root)).toBe(served);
    // Present but not the pinned size: not in place.
    writeFileSync(join(served, "needle.wasm"), "y");
    expect(whistleEngineInPlace(root)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("this checkout's vendored engine is in place", () => {
    expect(whistleEngineInPlace(join(import.meta.dir, "..", ".."))).toBe(true);
  });
});
