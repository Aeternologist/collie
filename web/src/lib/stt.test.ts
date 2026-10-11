import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchSttModel } from "@/lib/api";
import { server } from "@/test/setup";
import { t } from "./i18n";
import {
  __resetSttEngine,
  noteSttProbe,
  phoneEngineBlock,
  setSttEnginePreference,
  sttEnginePreference,
  sttModelErrorMessage,
  sttProbeState,
  type PhoneEngineEnv,
} from "./stt";
import { SttModelError, type SttModelErrorCode } from "./stt-model";

const KEY = "collie:stt-engine:v1";
const FULL_ENV: PhoneEngineEnv = {
  secureContext: true,
  webAssembly: true,
  worker: true,
  subtleCrypto: true,
  cacheStorage: true,
  bigInt: true,
};

beforeEach(() => {
  localStorage.clear();
  __resetSttEngine();
});
afterEach(() => vi.restoreAllMocks());

describe("the engine preference", () => {
  it("is the host until the person chooses, and a stranger's value is not a choice", async () => {
    expect(sttEnginePreference()).toBe("host");
    localStorage.setItem(KEY, "cloud");
    vi.resetModules();
    const fresh = await import("./stt");
    expect(fresh.sttEnginePreference()).toBe("host");
  });

  it("is kept in localStorage under its own key and read back by a new page", async () => {
    setSttEnginePreference("phone");
    expect(localStorage.getItem(KEY)).toBe("phone");
    vi.resetModules();
    const fresh = await import("./stt");
    expect(fresh.sttEnginePreference()).toBe("phone");
  });

  it("still applies for the session when storage refuses the write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    setSttEnginePreference("phone");
    expect(sttEnginePreference()).toBe("phone");
  });
});

describe("phoneEngineBlock: the first reason, in the order a person can act on", () => {
  const base = { env: FULL_ENV, probe: "unknown" as const, haveLocalModel: true, hostReady: true };

  it("is null when nothing rules the phone out", () => {
    expect(phoneEngineBlock(base)).toBeNull();
    expect(phoneEngineBlock({ ...base, probe: "ok" })).toBeNull();
  });

  it("names an insecure connection before anything else", () => {
    expect(phoneEngineBlock({ ...base, env: { ...FULL_ENV, secureContext: false, webAssembly: false }, probe: "wasm-csp" })).toBe("insecure");
  });

  it("names each missing browser feature as the browser", () => {
    for (const missing of ["webAssembly", "worker", "subtleCrypto", "cacheStorage", "bigInt"] as const) {
      expect(phoneEngineBlock({ ...base, env: { ...FULL_ENV, [missing]: false } })).toBe("browser");
    }
  });

  it("names what the worker probe said", () => {
    expect(phoneEngineBlock({ ...base, probe: "wasm-csp" })).toBe("wasm-csp");
    expect(phoneEngineBlock({ ...base, probe: "glue-failed" })).toBe("engine");
    expect(phoneEngineBlock({ ...base, probe: "crashed" })).toBe("engine");
  });

  it("asks for the setup only while the phone has no copy of its own", () => {
    expect(phoneEngineBlock({ ...base, haveLocalModel: false, hostReady: false })).toBe("host-not-ready");
    expect(phoneEngineBlock({ ...base, haveLocalModel: false, hostReady: true })).toBeNull();
    expect(phoneEngineBlock({ ...base, haveLocalModel: true, hostReady: false })).toBeNull();
  });
});

describe("the probe's answer", () => {
  it("keeps the browser's refusal and drops an aborted probe", () => {
    noteSttProbe({ ok: false, reason: "aborted" });
    expect(sttProbeState()).toBe("unknown");
    noteSttProbe({ ok: false, reason: "wasm-csp" });
    expect(sttProbeState()).toBe("wasm-csp");
    noteSttProbe({ ok: true });
    expect(sttProbeState()).toBe("ok");
    noteSttProbe({ ok: false, reason: "disabled" });
    expect(sttProbeState()).toBe("crashed");
  });

  it("runs a throwaway engine once, records what it said, and stops the worker", async () => {
    const dispose = vi.fn();
    const probe = vi.fn(async () => ({ ok: false as const, reason: "wasm-csp" as const }));
    const createSttEngine = vi.fn(() => ({ probe, dispose, transcribe: vi.fn() }));
    vi.resetModules();
    vi.doMock("@/lib/stt-engine", () => ({ createSttEngine }));
    const fresh = await import("./stt");
    await Promise.all([fresh.runSttProbe(), fresh.runSttProbe()]);
    await fresh.runSttProbe();
    expect(createSttEngine).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(fresh.sttProbeState()).toBe("wasm-csp");
    vi.doUnmock("@/lib/stt-engine");
  });

  it("stays unknown when the probe itself cannot run", async () => {
    vi.resetModules();
    vi.doMock("@/lib/stt-engine", () => ({
      createSttEngine: () => {
        throw new Error("no Worker here");
      },
    }));
    const fresh = await import("./stt");
    await fresh.runSttProbe();
    expect(fresh.sttProbeState()).toBe("unknown");
    vi.doUnmock("@/lib/stt-engine");
  });
});

describe("sttModelErrorMessage", () => {
  const CODES: SttModelErrorCode[] = [
    "unsupported",
    "low-space",
    "unknown-model",
    "download-failed",
    "busy",
    "hash-mismatch",
    "engine-mismatch",
    "aborted",
    "storage-failed",
    "damaged",
    "missing",
  ];

  it("has its own sentence for every code, none of them a raw key", () => {
    const sentences = CODES.map((c) => sttModelErrorMessage(new SttModelError(c)));
    expect(new Set(sentences).size).toBe(CODES.length);
    for (const sentence of sentences) expect(sentence).not.toMatch(/^stt\.model\./);
  });

  it("says the host's own refusal when the copy broke on a code this build knows", async () => {
    server.use(
      http.get(`/api/stt/model/${"d".repeat(64)}`, () =>
        HttpResponse.json({ error: "unknown model", code: "stt.model_unknown" }, { status: 404 }),
      ),
    );
    let cause: unknown;
    try {
      await fetchSttModel("d".repeat(64));
    } catch (thrown) {
      cause = thrown;
    }
    expect(sttModelErrorMessage(new SttModelError("download-failed", undefined, { cause }))).toBe(t("apiError.stt.model_unknown"));
  });

  it("falls back to 'Download stopped' for a break with no code, and describes a foreign throw", () => {
    expect(sttModelErrorMessage(new SttModelError("download-failed", undefined, { cause: new TypeError("offline") }))).toBe(
      t("stt.model.error.downloadFailed"),
    );
    expect(sttModelErrorMessage(new Error("boom"))).toBe("boom");
  });
});
