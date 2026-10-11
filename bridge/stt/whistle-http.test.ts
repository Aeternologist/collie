import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSttSettingsReader, sttSettingsPath } from "./config.ts";
import { createWhistleModelStore, resetWhistleModelState, whistlePaths, type WhistleModelPin } from "./whistle-model.ts";
import { MODEL_CSP, modelResponse, resetModelSends, whistleGet, whistleHost, whistleRemove, whistleStart, type WhistleRouteDeps } from "./whistle-http.ts";

// The Whistle routes' rules, driven without Bun.serve. The gate in front of them (read vs write) is
// pinned in server.test.ts, where the dispatch lives.

const MODEL = new TextEncoder().encode("a tiny stand-in for whistle.cact, served by a fake fetch");
const SHA = createHash("sha256").update(MODEL).digest("hex");
const PIN: WhistleModelPin = { url: "https://models.invalid/whistle.cact", revision: "rev1", sha256: SHA, bytes: MODEL.byteLength };

let stateDir: string;
let fetches: number;

beforeEach(() => {
  resetWhistleModelState();
  resetModelSends();
  stateDir = mkdtempSync(join(tmpdir(), "collie-whistle-http-"));
  fetches = 0;
});
afterEach(() => {
  resetWhistleModelState();
  rmSync(stateDir, { recursive: true, force: true });
});

function deps(env: Record<string, string | undefined> = {}): WhistleRouteDeps {
  const store = createWhistleModelStore({
    stateDir,
    version: "1.20.0",
    pin: PIN,
    accepted: [SHA],
    fetch: async () => {
      fetches += 1;
      return new Response(MODEL, { headers: { "content-length": String(MODEL.byteLength) } });
    },
  });
  return { store, stateDir, env };
}

async function ready(d: WhistleRouteDeps): Promise<void> {
  await d.store.start();
  await d.store.settled();
}

const sttJson = (): string | null => (existsSync(sttSettingsPath(stateDir)) ? readFileSync(sttSettingsPath(stateDir), "utf8") : null);

describe("GET and POST /api/stt/whistle", () => {
  test("absent, then 202 downloading, then ready; a second POST is 200 and fetches nothing", async () => {
    const d = deps();
    const first = await (await whistleGet(d)).json();
    expect(first).toEqual({ state: "absent", bytes: MODEL.byteLength, hostEngine: false, hostTaken: false });

    const started = await whistleStart(d);
    expect(started.response.status).toBe(202);
    expect(await started.response.json()).toMatchObject({ state: "downloading" });
    await d.store.settled();
    expect(await (await whistleGet(d)).json()).toEqual({ state: "ready", bytes: MODEL.byteLength, sha256: SHA, hostEngine: false, hostTaken: false });

    const again = await whistleStart(d);
    expect(again.response.status).toBe(200);
    expect(again.attempt).toEqual({ status: 200, outcome: "ready" });
    expect(fetches).toBe(1);
  });

  test("a start that cannot even begin is stt.whistle_download_failed, with a reason and no path", async () => {
    if (process.platform === "win32") return;
    const d = deps();
    writeFileSync(join(stateDir, "whistle"), "a file where the folder goes");
    const result = await whistleStart(d);
    expect(result.response.status).toBe(500);
    const body = await result.response.json();
    expect(body.code).toBe("stt.whistle_download_failed");
    expect(JSON.stringify(body)).not.toContain(stateDir);
    expect(fetches).toBe(0);
  });

  test("another provider is reported as taken, and an unreadable stt.json counts as taken", async () => {
    writeFileSync(sttSettingsPath(stateDir), JSON.stringify({ provider: "local-cli", command: "/usr/bin/whisper" }));
    expect(await (await whistleGet(deps())).json()).toMatchObject({ hostEngine: false, hostTaken: true });
    writeFileSync(sttSettingsPath(stateDir), "{ not json");
    expect(await (await whistleGet(deps())).json()).toMatchObject({ hostEngine: false, hostTaken: true });
    // The implicit openai-compatible: fields, no provider.
    writeFileSync(sttSettingsPath(stateDir), JSON.stringify({ baseUrl: "http://127.0.0.1:8080/v1" }));
    expect(await (await whistleGet(deps())).json()).toMatchObject({ hostTaken: true });
    // The environment counts the same.
    rmSync(sttSettingsPath(stateDir));
    expect(await (await whistleGet(deps({ COLLIE_STT_PROVIDER: "codex" }))).json()).toMatchObject({ hostTaken: true });
  });
});

describe("PUT /api/stt/whistle/host", () => {
  test("on needs the model first: 409 stt.whistle_not_ready, and nothing is written", async () => {
    const result = await whistleHost(deps(), { on: true });
    expect(result.response.status).toBe(409);
    expect((await result.response.json()).code).toBe("stt.whistle_not_ready");
    expect(sttJson()).toBeNull();
  });

  test("on with no other provider writes exactly { provider: whistle } at 0600, and the gate reads it with no restart", async () => {
    const d = deps();
    await ready(d);
    const read = createSttSettingsReader({ stateDir, warn: () => undefined, env: {} });
    expect(await read()).toBeNull();

    const result = await whistleHost(d, { on: true });
    expect(result.response.status).toBe(200);
    expect(await result.response.json()).toMatchObject({ state: "ready", hostEngine: true, hostTaken: false });
    expect(JSON.parse(sttJson()!)).toEqual({ provider: "whistle" });
    if (process.platform !== "win32") expect(statSync(sttSettingsPath(stateDir)).mode & 0o777).toBe(0o600);
    expect(existsSync(`${sttSettingsPath(stateDir)}.tmp`)).toBe(false);
    expect(await read()).toEqual({ provider: "whistle" });

    // Off removes it, and the same reader sees speech-to-text off.
    const off = await whistleHost(d, { on: false });
    expect(off.response.status).toBe(200);
    expect(await off.response.json()).toMatchObject({ hostEngine: false });
    expect(sttJson()).toBeNull();
    expect(await read()).toBeNull();
  });

  test("on never replaces a provider the operator set up: 409 stt.whistle_provider_taken, file untouched", async () => {
    const d = deps();
    await ready(d);
    const theirs = JSON.stringify({ provider: "openai-compatible", baseUrl: "http://127.0.0.1:8080/v1" });
    writeFileSync(sttSettingsPath(stateDir), theirs);
    const result = await whistleHost(d, { on: true });
    expect(result.response.status).toBe(409);
    expect((await result.response.json()).code).toBe("stt.whistle_provider_taken");
    expect(sttJson()).toBe(theirs);
    // Nor does off remove it.
    const off = await whistleHost(d, { on: false });
    expect(off.response.status).toBe(409);
    expect(sttJson()).toBe(theirs);
  });

  test("off with nothing configured is a no-op, and off cannot undo an environment that names whistle", async () => {
    const d = deps();
    expect((await whistleHost(d, { on: false })).response.status).toBe(200);
    const env = deps({ COLLIE_STT_PROVIDER: "whistle" });
    await ready(env);
    expect(await (await whistleGet(env)).json()).toMatchObject({ hostEngine: true, hostTaken: false });
    expect((await whistleHost(env, { on: false })).response.status).toBe(409);
  });

  test("a body that is not { on: boolean } is a 400", async () => {
    for (const body of [null, {}, { on: "yes" }, "on", [true]]) {
      expect((await whistleHost(deps(), body)).response.status).toBe(400);
    }
  });
});

describe("DELETE /api/stt/whistle", () => {
  test("removes the model and the whistle provider", async () => {
    const d = deps();
    await ready(d);
    await whistleHost(d, { on: true });
    const result = await whistleRemove(d);
    expect(result.response.status).toBe(200);
    expect(await result.response.json()).toEqual({ state: "absent", bytes: MODEL.byteLength, hostEngine: false, hostTaken: false });
    expect(existsSync(whistlePaths(stateDir).model)).toBe(false);
    expect(sttJson()).toBeNull();
  });

  test("leaves another provider alone", async () => {
    const d = deps();
    await ready(d);
    const theirs = JSON.stringify({ provider: "codex" });
    writeFileSync(sttSettingsPath(stateDir), theirs);
    await whistleRemove(d);
    expect(sttJson()).toBe(theirs);
  });
});

describe("GET /api/stt/model/<sha256>", () => {
  test("the held model, whole, with the ADR's headers", async () => {
    const d = deps();
    await ready(d);
    const { response, attempt } = await modelResponse(d, SHA);
    expect(response.status).toBe(200);
    expect(attempt).toEqual({ status: 200, outcome: "ok" });
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-length")).toBe(String(MODEL.byteLength));
    expect(response.headers.get("etag")).toBe(`"${SHA}"`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toBe(MODEL_CSP);
    expect(MODEL_CSP).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("accept-ranges")).toBe("none");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(MODEL);
  });

  test("another hash, a non-hash, a path-shaped value, or no model is 404 stt.model_unknown", async () => {
    const d = deps();
    const none = await modelResponse(d, SHA);
    expect(none.response.status).toBe(404);
    expect((await none.response.json()).code).toBe("stt.model_unknown");

    await ready(d);
    for (const asked of ["0".repeat(64), SHA.toUpperCase(), "../whistle.cact", `${SHA}/x`, "whistle.cact", ""]) {
      const { response } = await modelResponse(d, asked);
      expect(response.status).toBe(404);
    }
  });

  test("a file that changed size since it was hashed is not served", async () => {
    const d = deps();
    await ready(d);
    writeFileSync(whistlePaths(stateDir).model, "different length now");
    const { response } = await modelResponse(d, SHA);
    expect(response.status).toBe(404);
  });

  test("the hash is cached by size and mtime: a request does not read the file to find it", async () => {
    const d = deps();
    await ready(d);
    const path = whistlePaths(stateDir).model;
    utimesSync(path, 1_700_000_000, 1_700_000_000);
    // Same size, mtime and inode: the cache holds, so nothing is re-hashed per request. A change that
    // keeps all three is the phone's to catch, which hashes what it received before keeping a byte.
    expect((await d.store.ready())?.sha256).toBe(SHA);
    writeFileSync(path, new Uint8Array(MODEL.byteLength).fill(66));
    utimesSync(path, 1_700_000_000, 1_700_000_000);
    const { response } = await modelResponse(d, SHA);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(MODEL.byteLength));
    await response.body?.cancel();
  });

  test("a Range request to a real server still gets the whole body with a 200", async () => {
    const d = deps();
    await ready(d);
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async () => (await modelResponse(d, SHA)).response });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`, { headers: { range: "bytes=4-9" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-range")).toBeNull();
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(MODEL);
    } finally {
      await server.stop(true);
    }
  });

  test("a third copy at the same time is 503 stt.model_busy, and a finished or cancelled one frees its place", async () => {
    const d = deps();
    await ready(d);
    const first = await modelResponse(d, SHA);
    const second = await modelResponse(d, SHA);
    expect([first.response.status, second.response.status]).toEqual([200, 200]);
    const third = await modelResponse(d, SHA);
    expect(third.response.status).toBe(503);
    expect((await third.response.json()).code).toBe("stt.model_busy");
    expect(third.response.headers.get("retry-after")).toBe("5");

    // One read to the end frees a place; so does a cancel (a phone that went away).
    expect(new Uint8Array(await first.response.arrayBuffer())).toEqual(MODEL);
    const fourth = await modelResponse(d, SHA);
    expect(fourth.response.status).toBe(200);
    await second.response.body?.cancel();
    const fifth = await modelResponse(d, SHA);
    expect(fifth.response.status).toBe(200);
    await fourth.response.body?.cancel();
    await fifth.response.body?.cancel();
    expect((await modelResponse(d, SHA)).response.status).toBe(200);
  });
});
