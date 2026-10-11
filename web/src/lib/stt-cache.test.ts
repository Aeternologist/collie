import { describe, expect, it } from "vitest";

import { ACCEPTED_WHISTLE_SHAS, NEEDLE_VERSION_DIR } from "@/stt/pins";
import {
  isSttCacheName,
  modelShaOfPath,
  stripMount,
  sttCacheName,
  sttEnginePath,
  sttModelPath,
  sttStorable,
  sttSweepKeeps,
} from "./stt-cache";

const ACCEPTED = ACCEPTED_WHISTLE_SHAS[0] ?? "";
const OTHER = "a".repeat(64);

function response(init: { status?: number; type?: string; redirected?: boolean }): Response {
  const res = new Response("x", {
    status: init.status ?? 200,
    headers: init.type === undefined ? {} : { "content-type": init.type },
  });
  Object.defineProperty(res, "redirected", { value: init.redirected === true });
  return res;
}

describe("the speech cache's names", () => {
  it("is named per mount, the way the font cache is", () => {
    expect(sttCacheName("/")).toBe("collie-stt");
    expect(sttCacheName("/collie/")).toBe("collie-stt:/collie/");
  });

  it("recognises its own caches, whatever the mount, and nobody else's", () => {
    expect(isSttCacheName("collie-stt")).toBe(true);
    expect(isSttCacheName("collie-stt:/collie/")).toBe(true);
    expect(isSttCacheName("collie-fonts")).toBe(false);
    expect(isSttCacheName("workbox-precache-v2-https://x/")).toBe(false);
  });

  it("puts the model under its hash and the engine under the pinned version", () => {
    expect(sttModelPath(ACCEPTED)).toBe(`/api/stt/model/${ACCEPTED}`);
    expect(sttEnginePath("needle.wasm")).toBe(`/stt/${NEEDLE_VERSION_DIR}/needle.wasm`);
    expect(modelShaOfPath(sttModelPath(ACCEPTED))).toBe(ACCEPTED);
    expect(modelShaOfPath("/api/stt/model/not-a-hash")).toBeNull();
    expect(modelShaOfPath("/stt/worker.js")).toBeNull();
  });

  it("takes the mount off a pathname", () => {
    expect(stripMount("/stt/a.js", "/")).toBe("/stt/a.js");
    expect(stripMount("/collie/stt/a.js", "/collie/")).toBe("/stt/a.js");
    expect(stripMount("/other/stt/a.js", "/collie/")).toBe("/other/stt/a.js");
  });
});

describe("what the activate sweep keeps", () => {
  it("keeps a model this build accepts and drops one it does not", () => {
    expect(sttSweepKeeps(sttModelPath(ACCEPTED))).toBe(true);
    expect(sttSweepKeeps(sttModelPath(OTHER))).toBe(false);
  });

  it("keeps this build's engine files and drops another version's", () => {
    expect(sttSweepKeeps(sttEnginePath("needle.js"))).toBe(true);
    expect(sttSweepKeeps(sttEnginePath("needle.wasm"))).toBe(true);
    expect(sttSweepKeeps("/stt/needle-2-oldoldol/needle.wasm")).toBe(false);
  });

  it("drops the old worker script, whose name carries a build hash", () => {
    expect(sttSweepKeeps("/stt/worker-abc123.js")).toBe(false);
  });

  it("takes the accepted list as an argument, so a new pin set changes the answer", () => {
    expect(sttSweepKeeps(sttModelPath(OTHER), [OTHER])).toBe(true);
    expect(sttSweepKeeps(sttModelPath(ACCEPTED), [OTHER])).toBe(false);
  });
});

describe("what may be stored", () => {
  it("takes an unredirected 200 of the type the path promises", () => {
    expect(sttStorable(response({ type: "text/javascript; charset=utf-8" }), "/stt/worker-1.js")).toBe(true);
    expect(sttStorable(response({ type: "application/wasm" }), sttEnginePath("needle.wasm"))).toBe(true);
    expect(sttStorable(response({ type: "application/octet-stream" }), sttModelPath(ACCEPTED))).toBe(true);
  });

  it("refuses a sign-in page that came back as 200 HTML after a redirect", () => {
    expect(sttStorable(response({ type: "text/html", redirected: true }), "/stt/worker-1.js")).toBe(false);
    expect(sttStorable(response({ type: "text/javascript", redirected: true }), "/stt/worker-1.js")).toBe(false);
  });

  it("refuses a wrong type, a partial answer and an error", () => {
    expect(sttStorable(response({ type: "text/html" }), "/stt/worker-1.js")).toBe(false);
    expect(sttStorable(response({ type: "text/javascript" }), sttEnginePath("needle.wasm"))).toBe(false);
    expect(sttStorable(response({ status: 206, type: "text/javascript" }), "/stt/worker-1.js")).toBe(false);
    expect(sttStorable(response({ status: 404, type: "text/javascript" }), "/stt/worker-1.js")).toBe(false);
    expect(sttStorable(response({}), "/stt/worker-1.js")).toBe(false);
  });

  it("stores nothing else under stt/", () => {
    expect(sttStorable(response({ type: "text/plain" }), "/stt/needle-3-93e88ede/LICENSE")).toBe(false);
  });
});
