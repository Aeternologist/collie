import { createHash } from "node:crypto";
import { constants, existsSync, statSync } from "node:fs";
import { type FileHandle, chmod, lstat, mkdir, open, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { WhistleStatus } from "../types.ts";
import { ACCEPTED_WHISTLE_SHAS, NEEDLE_JS_BYTES, NEEDLE_VERSION_DIR, NEEDLE_WASM_BYTES, WHISTLE_MODEL } from "./whistle-pins.ts";

// ── THE WHISTLE MODEL ON THE HOST (ADR 0096 Decision 2) ──────────────────────────────────────
//
// One file, `<stateDir>/whistle/whistle.cact`, with a manifest beside it. Two acts put it there
// and nothing else does: a tap in Settings (`POST /api/stt/whistle`) and `collie stt whistle`. Both
// come through {@link createWhistleModelStore}. This module is the bridge's SECOND outbound path,
// beside the update check, and it is bounded like this:
//
//   • one address — the pinned Hugging Face commit URL in `whistle-pins.ts`, never a client value,
//     with an honest `User-Agent: Collie/<version>`. Redirects are followed: the CDN host behind it
//     differs by region and has changed before (ADR 0096 Decision 7).
//   • one download in flight per process — a second start joins the first, and a start when the
//     held file already matches a pin answers "ready" without a request.
//   • one download in flight per FOLDER, across processes: the bridge and a `collie stt whistle` run
//     are separate processes, so the part file is the lock. It is created exclusively (`wx`); one
//     younger than the deadline belongs to a download that may still be running, and a second
//     downloader reports that and fetches nothing. One older than the deadline is a crash's, and is
//     removed. (Two processes that both judge the same stale file can still race once. The loser's
//     rename fails and it reports a failure; no corrupt model is ever renamed into place, because
//     the hash gate comes first.)
//   • a 32 MiB cap, counted on the bytes as they arrive, and a 10-minute deadline.
//   • streamed to `whistle.cact.part` (0600, created exclusively) with a running sha256, and renamed
//     into place only when the hash equals the pin. Any failure deletes the part file and records a
//     short reason, which `GET /api/stt/whistle` reports. No path ever reaches that reason.
//   • the folder is 0700, every file 0600, and a symlink at any of the paths is refused (lstat): the
//     state dir is the operator's, but nothing here follows a link out of it.
//
// The held file's hash is computed once per change of its size, mtime or inode, not per request:
// `/api/config` asks for it on every page load and a 17 MB hash is not free.

export const WHISTLE_MODEL_FILENAME = "whistle.cact";
export const WHISTLE_MANIFEST_FILENAME = "whistle.json";
export const WHISTLE_PART_FILENAME = "whistle.cact.part";

/**
 * The names this module writes into the folder, for the Windows access-list rule that judges the
 * folder "Collie's own" (bridge/acl-policy.ts `KNOWN_FOLDERS`, which keeps a pattern of its own;
 * a test holds the two together).
 */
export const WHISTLE_FOLDER_NAMES = [WHISTLE_MODEL_FILENAME, WHISTLE_MANIFEST_FILENAME, WHISTLE_PART_FILENAME] as const;

/** The most bytes a download may deliver before it is stopped. The pinned model is 16.9 MB. */
export const WHISTLE_DOWNLOAD_CAP_BYTES = 32 * 1024 * 1024;

/** How long one download may take, request to rename. 18 MB took 29 s over a tailnet. */
export const WHISTLE_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** The paths of the model, its manifest and the part file, under one state dir. */
export interface WhistlePaths {
  dir: string;
  model: string;
  manifest: string;
  part: string;
}

export function whistlePaths(stateDir: string): WhistlePaths {
  // Spelled out rather than through a constant, so the state-dir guard (solo-baseline.test.ts) reads it.
  // A folder of its own, one level under the state dir: the Windows access-list rule judges a folder
  // "Collie's own" one level deep, and a `stt/` holding a subfolder would fail it.
  const dir = join(stateDir, "whistle");
  return {
    dir,
    model: join(dir, WHISTLE_MODEL_FILENAME),
    manifest: join(dir, WHISTLE_MANIFEST_FILENAME),
    part: join(dir, WHISTLE_PART_FILENAME),
  };
}

/**
 * The folder the vendored engine is read from: the served copy in `web/dist/stt/<version>/`, or in a
 * source checkout with no web build yet, the vendored copy in `web/public/stt/<version>/` that Vite
 * would copy there byte for byte. Either way the bytes are checked against the pins before use.
 */
export function whistleEngineDir(root: string): string {
  const served = join(root, "web", "dist", "stt", NEEDLE_VERSION_DIR);
  if (existsSync(join(served, "needle.js"))) return served;
  return join(root, "web", "public", "stt", NEEDLE_VERSION_DIR);
}

/**
 * Whether the two engine files are in place at their pinned sizes. A cheap check for the provider's
 * status, asked on every config read; the child hashes both before it compiles anything.
 */
export function whistleEngineInPlace(root: string): boolean {
  const dir = whistleEngineDir(root);
  try {
    return statSync(join(dir, "needle.js")).size === NEEDLE_JS_BYTES && statSync(join(dir, "needle.wasm")).size === NEEDLE_WASM_BYTES;
  } catch {
    return false;
  }
}

/** What the store reports. The route adds the host engine's two flags to make a `WhistleStatus`. */
export type WhistleModelStatus = Pick<WhistleStatus, "state" | "bytes" | "received" | "sha256" | "reason">;

/** The manifest beside the model: where it came from, for `collie stt status` and `doctor`. */
export interface WhistleManifest {
  version: 1;
  model: { sha256: string; bytes: number; revision: string; source: string; fetchedAt: string };
}

/** The model a download aims at. {@link WHISTLE_MODEL} unless a test pins a small one. */
export interface WhistleModelPin {
  url: string;
  revision: string;
  sha256: string;
  bytes: number;
}

/** The slice of `fetch` the download uses, so a test can stand in for Hugging Face. */
export type WhistleFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface WhistleModelDeps {
  stateDir: string;
  /** Collie's version, for the `User-Agent`. */
  version: string;
  fetch?: WhistleFetch;
  /** The clock the manifest's `fetchedAt` reads. */
  now?: () => number;
  pin?: WhistleModelPin;
  /** The hashes this build accepts. {@link ACCEPTED_WHISTLE_SHAS} unless a test names its own. */
  accepted?: readonly string[];
  capBytes?: number;
  timeoutMs?: number;
}

/** The held model, once its hash is one this build accepts. */
export interface WhistleReady {
  path: string;
  sha256: string;
  bytes: number;
}

/**
 * What `start()` did: joined or began a download, found the model already in place, or could not
 * begin. `elsewhere` is set on "downloading" when the download belongs to ANOTHER process (a part file
 * younger than the deadline): this one fetched nothing, and `status.received` is that file's size.
 */
export type WhistleStart =
  | { outcome: "ready"; status: WhistleModelStatus }
  | { outcome: "downloading"; status: WhistleModelStatus; elsewhere?: boolean }
  | { outcome: "refused"; reason: string };

export interface WhistleModelStore {
  readonly paths: WhistlePaths;
  status(): Promise<WhistleModelStatus>;
  /** The held model when its hash is accepted, else null. Stat-cheap after the first hash. */
  ready(): Promise<WhistleReady | null>;
  /** Start the download, or join the one in flight. Idempotent when the model is ready. */
  start(): Promise<WhistleStart>;
  /**
   * Take a local file instead of a download (`collie stt whistle --from`), through the same single
   * flight, the same part file and the same hash gate. A symlink or a non-file is refused before
   * anything is touched; a file whose hash is not the pin ends as a failure naming both hashes.
   */
  importFile(source: string): Promise<WhistleStart>;
  /** The model as the terminal reports it: absent, downloading, ready, not this release's, or unreadable. */
  describe(): Promise<WhistleDescription>;
  /** Stop a download in flight and delete the model, its manifest and any part file. */
  remove(): Promise<WhistleModelStatus>;
  /** Resolves when no download is in flight. For tests and for `collie stt whistle`. */
  settled(): Promise<void>;
  /** The manifest, or null when there is none or it cannot be read. */
  manifest(): Promise<WhistleManifest | null>;
}

/** What {@link WhistleModelStore.describe} reports. */
export type WhistleDescription =
  | { kind: "absent" }
  | { kind: "downloading"; received: number }
  | { kind: "ready"; sha256: string; bytes: number; revision: string | null }
  /** A file is there and readable, but its hash is not one this release accepts. */
  | { kind: "mismatch"; sha256: string; bytes: number }
  /** A file is there and cannot be read, or is a symlink or not a file. */
  | { kind: "unreadable"; reason: string };

/** A refusal whose message is Collie's own sentence and safe to report: no path, no upstream body. */
class WhistleRefusal extends Error {}

/** Another process owns the part file. Not a failure of this one, and nothing of theirs is touched. */
class WhistleRunning extends Error {}

/** A download in flight, shared by every store over the same folder in this process. */
interface InFlight {
  done: Promise<void>;
  received: number;
  controller: AbortController;
}

const inFlight = new Map<string, InFlight>();
/** The last failure per folder, until the next start or remove. In memory: a restart forgets it. */
const lastFailure = new Map<string, string>();
/** The held file's hash per path, keyed by what would change if the file did. */
const hashCache = new Map<string, { key: string; sha256: string }>();

/** Forget every download, failure and hash this process holds. For tests. */
export function resetWhistleModelState(): void {
  for (const flight of inFlight.values()) flight.controller.abort();
  inFlight.clear();
  lastFailure.clear();
  hashCache.clear();
}

/** The sha256 of a file, streamed. */
async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

/** Throw a refusal when `path` is a symlink (or anything but a regular file). Absent is fine. */
async function refuseOddFile(path: string, what: string): Promise<void> {
  let entry;
  try {
    entry = await lstat(path);
  } catch {
    return;
  }
  if (entry.isSymbolicLink()) throw new WhistleRefusal(`a symlink is in the way of the ${what}; Collie does not follow it`);
  if (!entry.isFile()) throw new WhistleRefusal(`something that is not a file is in the way of the ${what}`);
}

export function createWhistleModelStore(deps: WhistleModelDeps): WhistleModelStore {
  const paths = whistlePaths(deps.stateDir);
  const pin = deps.pin ?? WHISTLE_MODEL;
  const accepted = deps.accepted ?? ACCEPTED_WHISTLE_SHAS;
  const capBytes = deps.capBytes ?? WHISTLE_DOWNLOAD_CAP_BYTES;
  const timeoutMs = deps.timeoutMs ?? WHISTLE_DOWNLOAD_TIMEOUT_MS;
  const fetchImpl: WhistleFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? Date.now;

  /** What sits at the model's path: nothing, an accepted model, a model this build refuses, or an odd entry. */
  async function inspect(): Promise<
    | { kind: "absent" }
    | { kind: "held"; sha256: string; bytes: number; accepted: boolean }
    | { kind: "odd"; reason: string }
  > {
    let entry;
    try {
      entry = await lstat(paths.model);
    } catch {
      return { kind: "absent" };
    }
    if (entry.isSymbolicLink()) return { kind: "odd", reason: "a symlink is at the model's path; Collie does not follow it" };
    if (!entry.isFile()) return { kind: "odd", reason: "something that is not a file is at the model's path" };
    const key = `${entry.size}:${entry.mtimeMs}:${entry.ino}`;
    let cached = hashCache.get(paths.model);
    if (cached?.key !== key) {
      try {
        cached = { key, sha256: await hashFile(paths.model) };
      } catch {
        return { kind: "odd", reason: "the model on this host cannot be read" };
      }
      hashCache.set(paths.model, cached);
    }
    return { kind: "held", sha256: cached.sha256, bytes: entry.size, accepted: accepted.includes(cached.sha256) };
  }

  /** A download by another process: a part file younger than the deadline. Its size is what it received. */
  async function runningElsewhere(): Promise<{ received: number } | null> {
    let entry;
    try {
      entry = await lstat(paths.part);
    } catch {
      return null;
    }
    // A link or a folder is no download; `prepare` refuses it by name.
    if (!entry.isFile() || Date.now() - entry.mtimeMs >= timeoutMs) return null;
    return { received: entry.size };
  }

  /** What `collie stt status` and `doctor` say about the model, with more detail than the route needs. */
  async function describe(): Promise<WhistleDescription> {
    const flight = inFlight.get(paths.dir);
    if (flight !== undefined) return { kind: "downloading", received: flight.received };
    const held = await inspect();
    if (held.kind === "odd") return { kind: "unreadable", reason: held.reason };
    if (held.kind === "held") {
      if (!held.accepted) return { kind: "mismatch", sha256: held.sha256, bytes: held.bytes };
      return { kind: "ready", sha256: held.sha256, bytes: held.bytes, revision: (await readManifest())?.model.revision ?? null };
    }
    const other = await runningElsewhere();
    return other === null ? { kind: "absent" } : { kind: "downloading", received: other.received };
  }

  async function readManifest(): Promise<WhistleManifest | null> {
    try {
      // SAFETY: only ever written by this module, and every reader treats a missing field as absent.
      return JSON.parse(await readFile(paths.manifest, "utf8")) as WhistleManifest;
    } catch {
      return null;
    }
  }

  async function status(): Promise<WhistleModelStatus> {
    const flight = inFlight.get(paths.dir);
    if (flight !== undefined) return { state: "downloading", bytes: pin.bytes, received: flight.received };
    const held = await inspect();
    if (held.kind === "held" && held.accepted) return { state: "ready", bytes: pin.bytes, sha256: held.sha256 };
    const other = await runningElsewhere();
    if (other !== null) return { state: "downloading", bytes: pin.bytes, received: other.received };
    if (held.kind === "held") {
      return { state: "failed", bytes: pin.bytes, reason: "the model on this host is not one this version of Collie accepts; set it up again" };
    }
    if (held.kind === "odd") return { state: "failed", bytes: pin.bytes, reason: held.reason };
    const failure = lastFailure.get(paths.dir);
    if (failure !== undefined) return { state: "failed", bytes: pin.bytes, reason: failure };
    return { state: "absent", bytes: pin.bytes };
  }

  /**
   * The folder, 0700, with nothing odd in it, and the part file created exclusively: holding the
   * handle IS holding the cross-process lock. Throws a refusal, or {@link WhistleRunning}.
   */
  async function prepare(): Promise<FileHandle> {
    try {
      await mkdir(paths.dir, { recursive: true, mode: 0o700 });
    } catch {
      throw new WhistleRefusal("the model's folder could not be made in the state dir");
    }
    // `mkdir -p` follows a symlinked folder; lstat catches it afterwards. The state dir itself is
    // the operator's to place where they like, so it is not checked.
    const entry = await lstat(paths.dir);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new WhistleRefusal("the model's folder in the state dir is a symlink or not a folder; Collie does not follow it");
    }
    await chmod(paths.dir, 0o700);
    await refuseOddFile(paths.model, "model");
    await refuseOddFile(paths.manifest, "model's manifest");
    await refuseOddFile(paths.part, "download");
    // A part file this young is another process's download. An older one is a crash's: start over.
    if ((await runningElsewhere()) !== null) throw new WhistleRunning();
    await rm(paths.part, { force: true });
    // `wx`, and BEFORE the request, so the lock exists while the connection is being made. Created
    // here or not at all: nothing put at this path in the meantime is written through, and a second
    // downloader's `wx` fails.
    try {
      return await open(paths.part, "wx", 0o600);
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "EEXIST") throw new WhistleRunning();
      throw err;
    }
  }

  /** Fetch, stream, hash, rename. Throws a refusal with the reason to record. */
  async function download(flight: InFlight, file: FileHandle): Promise<void> {
    const signal = AbortSignal.any([flight.controller.signal, AbortSignal.timeout(timeoutMs)]);
    const hash = createHash("sha256");
    try {
      let res: Response;
      try {
        res = await fetchImpl(pin.url, {
          redirect: "follow",
          headers: { "user-agent": `Collie/${deps.version}`, accept: "application/octet-stream" },
          signal,
        });
      } catch {
        throw new WhistleRefusal(signal.aborted ? "the download took too long" : "the download could not reach Hugging Face");
      }
      if (!res.ok || res.body === null) {
        await res.body?.cancel().catch(() => undefined);
        throw new WhistleRefusal(`the download answered HTTP ${res.status}`);
      }
      const declared = Number(res.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > capBytes) {
        await res.body.cancel().catch(() => undefined);
        throw new WhistleRefusal(`the download is larger than ${capBytes / (1024 * 1024)} MiB`);
      }
      const reader = res.body.getReader();
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          throw new WhistleRefusal(signal.aborted ? "the download took too long" : "the download broke off");
        }
        if (chunk.done) break;
        flight.received += chunk.value.byteLength;
        if (flight.received > capBytes) {
          await reader.cancel().catch(() => undefined);
          throw new WhistleRefusal(`the download is larger than ${capBytes / (1024 * 1024)} MiB`);
        }
        hash.update(chunk.value);
        await file.write(chunk.value);
      }
    } finally {
      await file.close();
    }

    await finalize(hash.digest("hex"), flight.received, pin.url, "download");
  }

  /**
   * The hash gate, then the rename and the manifest. The part file is complete and closed. Nothing
   * reaches the model's path unless its hash is the pin: a mismatch throws with both hashes.
   */
  async function finalize(sha256: string, bytes: number, source: string, what: "download" | "file"): Promise<void> {
    if (sha256 !== pin.sha256 || !accepted.includes(sha256)) {
      throw new WhistleRefusal(`the ${what} did not match the pinned model (got ${sha256}, expected ${pin.sha256})`);
    }
    await refuseOddFile(paths.model, "model");
    await chmod(paths.part, 0o600);
    await rename(paths.part, paths.model);
    const manifest: WhistleManifest = {
      version: 1,
      model: { sha256, bytes, revision: pin.revision, source, fetchedAt: new Date(now()).toISOString() },
    };
    await refuseOddFile(paths.manifest, "model's manifest");
    await rm(paths.manifest, { force: true });
    await writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  }

  /** Copy a local file into the part file through the same running hash. Throws a refusal. */
  async function copyIn(source: string, flight: InFlight, file: FileHandle): Promise<void> {
    const hash = createHash("sha256");
    let input: FileHandle | null = null;
    try {
      try {
        // O_NOFOLLOW: a link swapped in after the lstat in `importFile` is refused here, not followed.
        input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch {
        throw new WhistleRefusal("the file could not be opened (a symlink, or no longer there)");
      }
      const entry = await input.stat();
      if (!entry.isFile()) throw new WhistleRefusal("that is not a regular file");
      if (entry.size > capBytes) throw new WhistleRefusal(`the file is larger than ${capBytes / (1024 * 1024)} MiB`);
      const buffer = new Uint8Array(1024 * 1024);
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.byteLength, null);
        if (bytesRead === 0) break;
        flight.received += bytesRead;
        if (flight.received > capBytes) throw new WhistleRefusal(`the file is larger than ${capBytes / (1024 * 1024)} MiB`);
        const piece = buffer.subarray(0, bytesRead);
        hash.update(piece);
        await file.write(piece);
      }
    } finally {
      await input?.close().catch(() => undefined);
      await file.close();
    }
    await finalize(hash.digest("hex"), flight.received, "a file the operator supplied", "file");
  }

  /** Run `fill` over a freshly locked part file as the one download in flight. See {@link WhistleModelStore.start}. */
  async function begin(fill: (flight: InFlight, file: FileHandle) => Promise<void>): Promise<WhistleStart> {
    const joined = inFlight.get(paths.dir);
    if (joined !== undefined) return { outcome: "downloading", status: await status() };
    const held = await inspect();
    if (held.kind === "held" && held.accepted) return { outcome: "ready", status: await status() };
    // Another process is downloading: report it, fetch nothing, touch nothing of theirs.
    const other = await runningElsewhere();
    // Checked again after the awaits: a start that raced this one owns the download.
    if (inFlight.has(paths.dir)) return { outcome: "downloading", status: await status() };
    if (other !== null) return { outcome: "downloading", status: await status(), elsewhere: true };

    const flight: InFlight = { done: Promise.resolve(), received: 0, controller: new AbortController() };
    let prepared!: (refusal: string | null) => void;
    /** Set when the part file turned out to be another process's. */
    let elsewhere = false;
    const preparation = new Promise<string | null>((resolve) => {
      prepared = resolve;
    });
    flight.done = (async () => {
      try {
        const file = await prepare();
        prepared(null);
        await fill(flight, file);
        lastFailure.delete(paths.dir);
      } catch (err) {
        if (err instanceof WhistleRunning) {
          // Another process won the part file between the check and here. Theirs stays as it is.
          elsewhere = true;
          prepared(null);
          return;
        }
        const reason = err instanceof WhistleRefusal ? err.message : "the download could not be written to the state dir";
        prepared(reason);
        await rm(paths.part, { force: true }).catch(() => undefined);
        // A download stopped by `remove()` is not a failure: the person asked for nothing to be there.
        if (!flight.controller.signal.aborted) lastFailure.set(paths.dir, reason);
      } finally {
        if (inFlight.get(paths.dir) === flight) inFlight.delete(paths.dir);
      }
    })();
    inFlight.set(paths.dir, flight);
    lastFailure.delete(paths.dir);

    const refusal = await preparation;
    if (refusal !== null) {
      await flight.done;
      return { outcome: "refused", reason: refusal };
    }
    if (elsewhere) {
      await flight.done;
      return { outcome: "downloading", status: await status(), elsewhere: true };
    }
    return { outcome: "downloading", status: await status() };
  }

  /** Take a local file through the same hash gate. Refuses a symlink or a non-file before any state is touched. */
  async function importFile(source: string): Promise<WhistleStart> {
    let entry;
    try {
      entry = await lstat(source);
    } catch {
      return { outcome: "refused", reason: "that file does not exist or cannot be read" };
    }
    if (entry.isSymbolicLink()) return { outcome: "refused", reason: "that is a symlink; Collie does not follow it, so name the file itself" };
    if (!entry.isFile()) return { outcome: "refused", reason: "that is not a regular file" };
    if (entry.size > capBytes) return { outcome: "refused", reason: `that file is larger than ${capBytes / (1024 * 1024)} MiB` };
    return begin((flight, file) => copyIn(source, flight, file));
  }

  async function remove(): Promise<WhistleModelStatus> {
    const flight = inFlight.get(paths.dir);
    if (flight !== undefined) {
      flight.controller.abort();
      await flight.done;
    }
    // `rm` on a symlink removes the link, never its target, so a removal needs no lstat.
    for (const path of [paths.model, paths.manifest, paths.part]) await rm(path, { force: true });
    // The folder too, when nothing else is in it. `rmdir` refuses a folder that still holds anything, so
    // a file the operator put there survives, and a symlinked folder is not followed.
    await rmdir(paths.dir).catch(() => undefined);
    hashCache.delete(paths.model);
    lastFailure.delete(paths.dir);
    return status();
  }

  return {
    paths,
    status,
    async ready() {
      const held = await inspect();
      return held.kind === "held" && held.accepted ? { path: paths.model, sha256: held.sha256, bytes: held.bytes } : null;
    },
    start: () => begin(download),
    importFile,
    describe,
    remove,
    async settled() {
      await inFlight.get(paths.dir)?.done;
    },
    manifest: readManifest,
  };
}
