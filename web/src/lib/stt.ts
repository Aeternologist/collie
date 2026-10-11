import { useEffect, useSyncExternalStore } from "react";

import { apiErrorFields, type SttResult } from "@/lib/api";
import { isApiErrorCode } from "@/lib/api-error-codes";
import { describeApiError, describeThrownError } from "@/lib/api-error-message";
import { t, type MessageKey } from "@/lib/i18n";
import {
  getSttCapability,
  getWhistleStatus,
  loadOperatorCommands,
  subscribeOperatorConfig,
} from "@/lib/operator-config";
import type { SttProbe } from "@/lib/stt-engine";
import { SttModelError, type SttModelErrorCode } from "@/lib/stt-model";
import type { SttCapability, WhistleStatus } from "@/lib/types";

/** The refusal half of one transcription attempt — the only shape `sttErrorMessage` has words for. */
type SttFailure = Extract<SttResult, { ok: false }>;

// THE PHONE'S HALF OF SPEECH-TO-TEXT (ADR 0029) — the policy, the support probe, the error words,
// and the one persisted setting. The recorder mechanics live in hooks/use-stt-recorder.ts and the
// transport in lib/api.ts; this file is what both of them, the composer and Settings agree on.
//
// TWO THINGS DECIDE WHETHER A MICROPHONE EXISTS HERE, and they are independent:
//
//  1. **The bridge published a provider.** `/api/config` carries `stt` only when the operator ran
//     `collie stt setup`; absent is the feature being off, which is also what an older bridge sends.
//     Absent draws NO button — not a disabled one. `available: false` is the other case: a provider
//     that exists and cannot serve right now, which DOES draw a disabled button carrying the
//     bridge's own `reason`, because the operator can fix that and needs to be told what to fix.
//  2. **This browser can actually record.** A `MediaRecorder`, a `getUserMedia`, and a secure
//     context. Over plain HTTP (a tailnet URL without `tailscale serve`) `navigator.mediaDevices` is
//     simply not there, and #115 shipped without this check — the button rendered and did nothing.
//     A control that provably cannot work is worse than no control, so this hides the button
//     entirely rather than disabling it: there is no operator action on the phone that fixes it.

/** The largest clip the phone will upload. Mirrors MAX_STT_AUDIO_BYTES in bridge/stt/http.ts — the
 *  bridge is still the enforcer; this is what stops an 8 MiB body being sent to be refused. */
export const MAX_STT_AUDIO_BYTES = 8 * 1024 * 1024;

/** Hard stop on one clip. A recording still running at five minutes is a pocket, not a reply. */
export const MAX_STT_DURATION_MS = 5 * 60 * 1000;

/** Containers a browser's MediaRecorder actually produces, best first. Every one of them is in the
 *  bridge's accepted set; the first the browser admits to supporting wins (Chrome/Firefox take the
 *  webm line, Safari the mp4 one). */
export const RECORDING_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"] as const;

/** A best-effort encoder hint. Speech at 24 kbps Opus is comfortably intelligible, and the point of
 *  asking is that a five-minute clip then lands nowhere near the 8 MiB ceiling. */
export function requestedRecordingBitrate(mimeType: string): number {
  return mimeType.startsWith("audio/mp4") ? 64_000 : 24_000;
}

/** The container this browser will record, or `null` when it will record none of them. */
export function pickRecordingMimeType(): string | null {
  if (!("MediaRecorder" in globalThis)) return null;
  for (const type of RECORDING_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

/**
 * Whether this browser can record at all — the second of the two gates in the header.
 *
 * `isSecureContext` is checked explicitly rather than left to `getUserMedia` throwing: on an
 * insecure origin the whole `mediaDevices` object is absent, so the failure would arrive as a
 * TypeError at the moment of the tap instead of as a button that was never drawn.
 */
export function sttRecordingSupported(): boolean {
  if (!globalThis.isSecureContext) return false;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  return pickRecordingMimeType() !== null;
}

/**
 * The bridge's speech-to-text block, or `null` when this phone must draw no record button — either
 * because no provider is configured or because this browser cannot record. One predicate so the
 * composer's button and the Settings row can never disagree about whether the feature exists.
 */
export function useSttCapability(): SttCapability | null {
  useEffect(() => {
    void loadOperatorCommands();
  }, []);
  const capability = useSyncExternalStore(
    subscribeOperatorConfig,
    getSttCapability,
    getSttCapability,
  );
  // Evaluated per render rather than memoised: it reads browser globals that do not change within a
  // page, and a memo keyed on nothing would only hide that.
  return capability !== null && sttRecordingSupported() ? capability : null;
}

/**
 * Operator-facing words for a failed transcription.
 *
 * THE CODE FIRST, the status only after it. A refusal from any current bridge carries the stable
 * `code` this app has a translated sentence for (`apiError.stt.*`), and the code says things the
 * status cannot: "the recording is empty" and "the recording could not be read" are both 400.
 *
 * The status ladder below is what remains for a bridge OLDER than the catalogue, which sends no code
 * at all. It is deliberately still here and deliberately still English: it is the pre-catalogue
 * behaviour, unchanged, and a phone talking to such a bridge is exactly the case where inventing a
 * new mapping would be guessing.
 */
export function sttErrorMessage(failure: SttFailure): string {
  if (isApiErrorCode(failure.code)) {
    return describeApiError({
      error: failure.error ?? undefined,
      code: failure.code,
      detail: failure.detail,
    });
  }
  const { status, error: serverError } = failure;
  if (status === 429) return t("stt.error.busy");
  if (status === 413) return t("stt.error.tooLong");
  if (status === 415) return t("stt.error.badFormat");
  if (status === 503) return t("stt.error.unconfigured");
  if (status === 504) return t("stt.error.timeout");
  if (status === 502) return t("stt.error.unreachable");
  return serverError ?? t("stt.error.generic");
}

// ── HANDS-FREE ──────────────────────────────────────────────────────────────────────────────────
//
// OFF by default, and it stays a deliberate act: with it on, a transcript is SENT rather than
// dropped in the box — through the same guarded reply path a typed message takes (ADR 0029), never
// around it. The composer owns the two refusals that setting can't express (a draft already in the
// box, a password prompt on screen); this store owns only the operator's answer to the question.
//
// Same shape as lib/haptics.ts: module state + subscribe + a useSyncExternalStore hook, persisted to
// localStorage. Per DEVICE, because "send what I say without showing me first" is a statement about
// where the phone is and who is holding it, not about the herd.

const HANDS_FREE_KEY = "collie:stt-hands-free:v1";

let handsFree = loadHandsFree();
const handsFreeListeners = new Set<() => void>();

function loadHandsFree(): boolean {
  try {
    return localStorage.getItem(HANDS_FREE_KEY) === "1";
  } catch {
    return false; // private mode / no storage — the default is the safe answer anyway
  }
}

export function handsFreeEnabled(): boolean {
  return handsFree;
}

export function setHandsFreeEnabled(on: boolean): void {
  handsFree = on;
  try {
    localStorage.setItem(HANDS_FREE_KEY, on ? "1" : "0");
  } catch {
    // Ignore quota / storage-disabled writes — the in-memory value still applies for this session.
  }
  for (const fn of handsFreeListeners) fn();
}

function subscribeHandsFree(cb: () => void): () => void {
  handsFreeListeners.add(cb);
  return () => handsFreeListeners.delete(cb);
}

export function useHandsFree(): boolean {
  return useSyncExternalStore(subscribeHandsFree, handsFreeEnabled, handsFreeEnabled);
}

/** Test helper — the setting is module state, so one case's toggle would outlive it. */
export function __resetHandsFree(): void {
  handsFree = false;
  handsFreeListeners.clear();
}

// ── THE SPEECH ENGINE IS A PER-DEVICE CHOICE (ADR 0096 Decision 1) ──────────────────────────────
//
// "Host" is whatever provider the host runs, `whistle` included, and is the default. "This phone"
// runs Whistle in the browser (lib/stt-engine.ts) and sends nothing. The choice is per DEVICE for the
// reason the typeface is (ADR 0033): whether a phone is strong enough is a fact about that phone. It
// is a preference, not session content, so the wipe keeps it.
//
// Same shape as the hands-free switch above: module state, subscribe, a useSyncExternalStore hook.

export type SttEngineChoice = "host" | "phone";

const ENGINE_KEY = "collie:stt-engine:v1";

function isEngineChoice(value: string | null): value is SttEngineChoice {
  return value === "host" || value === "phone";
}

function loadEngine(): SttEngineChoice {
  try {
    const stored = localStorage.getItem(ENGINE_KEY);
    return isEngineChoice(stored) ? stored : "host";
  } catch {
    return "host"; // private mode / no storage — the host is the default anyway
  }
}

let engineChoice = loadEngine();
const engineListeners = new Set<() => void>();

/** The engine this device asked for. Whether it can run is {@link phoneEngineBlock}'s question. */
export function sttEnginePreference(): SttEngineChoice {
  return engineChoice;
}

export function setSttEnginePreference(choice: SttEngineChoice): void {
  engineChoice = choice;
  try {
    localStorage.setItem(ENGINE_KEY, choice);
  } catch {
    // Quota or storage disabled — the in-memory value still applies for this session.
  }
  for (const fn of engineListeners) fn();
}

function subscribeEngine(cb: () => void): () => void {
  engineListeners.add(cb);
  return () => engineListeners.delete(cb);
}

export function useSttEnginePreference(): SttEngineChoice {
  return useSyncExternalStore(subscribeEngine, sttEnginePreference, sttEnginePreference);
}

/** Test helper — back to the default, listeners dropped. */
export function __resetSttEngine(): void {
  engineChoice = "host";
  engineListeners.clear();
  probeState = "unknown";
  probeListeners.clear();
  probeRun = null;
}

// ── WHY "THIS PHONE" CANNOT BE CHOSEN ───────────────────────────────────────────────────────────
//
// One reason, the first that applies, in the order a person can act on them: the connection, then the
// browser, then the engine, then the host. Absent means it can be chosen.

/** What a browser must have for the phone engine. Read once from the globals; a test hands in its own. */
export interface PhoneEngineEnv {
  secureContext: boolean;
  webAssembly: boolean;
  worker: boolean;
  subtleCrypto: boolean;
  cacheStorage: boolean;
  bigInt: boolean;
}

export function phoneEngineEnv(): PhoneEngineEnv {
  return {
    secureContext: globalThis.isSecureContext === true,
    webAssembly: "WebAssembly" in globalThis,
    worker: "Worker" in globalThis,
    subtleCrypto: globalThis.crypto?.subtle !== undefined,
    cacheStorage: "caches" in globalThis,
    bigInt: "BigInt" in globalThis,
  };
}

/** What the worker's own probe said: nothing yet, fine, or why the browser refused it. */
export type SttProbeState = "unknown" | "ok" | "wasm-csp" | "glue-failed" | "crashed";

let probeState: SttProbeState = "unknown";
const probeListeners = new Set<() => void>();

export function sttProbeState(): SttProbeState {
  return probeState;
}

/** Record a probe's answer. An aborted probe says nothing about the browser and is dropped. */
export function noteSttProbe(result: SttProbe): void {
  if (result.ok) probeState = "ok";
  else if (result.reason === "wasm-csp" || result.reason === "glue-failed") probeState = result.reason;
  else if (result.reason === "crashed" || result.reason === "disabled") probeState = "crashed";
  else return;
  for (const fn of probeListeners) fn();
}

function subscribeProbe(cb: () => void): () => void {
  probeListeners.add(cb);
  return () => probeListeners.delete(cb);
}

export function useSttProbeState(): SttProbeState {
  return useSyncExternalStore(subscribeProbe, sttProbeState, sttProbeState);
}

let probeRun: Promise<void> | null = null;

/**
 * Ask the speech worker whether this browser can run the engine, once per page session, and record the
 * answer. A throwaway engine: it starts the worker, which compiles its eight-byte module, and stops
 * it. It needs neither the model nor the network. The engine module loads on demand, so a page that
 * never opens Settings never pays for it. A worker that came through the service worker also lands in
 * the speech cache here (sw.ts), which is what makes the engine start offline.
 */
export function runSttProbe(): Promise<void> {
  if (probeState !== "unknown") return Promise.resolve();
  probeRun ??= (async () => {
    try {
      const { createSttEngine } = await import("@/lib/stt-engine");
      const engine = createSttEngine({ getBytes: () => Promise.reject(new Error("probe only")) });
      try {
        noteSttProbe(await engine.probe());
      } finally {
        engine.dispose();
      }
    } catch {
      // A probe that could not run says nothing; the state stays unknown and the engine decides at use.
    } finally {
      probeRun = null;
    }
  })();
  return probeRun;
}

/** Why "This phone" is off, or `null` when it can be chosen. */
export type PhoneEngineBlock = "insecure" | "browser" | "wasm-csp" | "engine" | "host-not-ready";

/**
 * The first reason "This phone" cannot be chosen (plan section 5 item 3).
 *
 * "Set up Whistle first" applies only while this phone holds no copy of its own: a phone that already
 * has the model can run it whatever the host does next, so removing it from the host does not
 * silently take the phone's engine away.
 */
export function phoneEngineBlock(input: {
  env: PhoneEngineEnv;
  probe: SttProbeState;
  haveLocalModel: boolean;
  hostReady: boolean;
}): PhoneEngineBlock | null {
  const { env, probe, haveLocalModel, hostReady } = input;
  if (!env.secureContext) return "insecure";
  if (!env.webAssembly || !env.worker || !env.subtleCrypto || !env.cacheStorage || !env.bigInt) return "browser";
  if (probe === "wasm-csp") return "wasm-csp";
  if (probe === "glue-failed" || probe === "crashed") return "engine";
  if (!haveLocalModel && !hostReady) return "host-not-ready";
  return null;
}

/**
 * The host's Whistle model status, or `null` when this collie offers none (an older bridge, or a crew
 * member's own answer). Settings draws its Whistle block from this and from nothing else.
 */
export function useWhistleStatus(): WhistleStatus | null {
  useEffect(() => {
    void loadOperatorCommands();
  }, []);
  return useSyncExternalStore(subscribeOperatorConfig, getWhistleStatus, getWhistleStatus);
}

// ── THE MODEL STORE'S WORDS ─────────────────────────────────────────────────────────────────────

const MODEL_ERROR_KEYS = {
  unsupported: "stt.model.error.unsupported",
  "low-space": "stt.model.error.lowSpace",
  "unknown-model": "stt.model.error.unknownModel",
  "download-failed": "stt.model.error.downloadFailed",
  busy: "stt.model.error.busy",
  "hash-mismatch": "stt.model.error.hashMismatch",
  "engine-mismatch": "stt.model.error.engineMismatch",
  aborted: "stt.model.error.aborted",
  "storage-failed": "stt.model.error.storageFailed",
  damaged: "stt.model.error.damaged",
  missing: "stt.model.error.missing",
} as const satisfies Record<SttModelErrorCode, MessageKey>;

/**
 * The sentence for a failure of the phone's model store (lib/stt-model.ts), in the operator's language.
 *
 * A copy that broke because the HOST refused says the host's own refusal when it sent a code this
 * build has a sentence for ("Your host no longer has that speech model"); any other break says
 * "Download stopped". A throw that is not the store's own is described like any other.
 */
export function sttModelErrorMessage<TThrown>(error: TThrown): string {
  if (!(error instanceof SttModelError)) return describeThrownError(error);
  if (error.code === "download-failed" && isApiErrorCode(apiErrorFields(error.cause)?.code)) {
    return describeThrownError(error.cause);
  }
  return t(MODEL_ERROR_KEYS[error.code]);
}
