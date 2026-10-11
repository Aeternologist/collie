import { homedir } from "node:os";

import { apiError, type ApiErrorDetail, type ErrorCode } from "../error-codes.ts";
import type { JsonValue } from "../json.ts";
import { findTool } from "../tools.ts";
import type { SttHostStatus, SttHostSwitch, SttHostSwitchReason } from "../types.ts";
import { CODEX_CONSENT_ID, probeCodexSetup, type CodexIdentityProbe } from "./codex-setup.ts";
import { createCodexDetector, type CodexDetector, type CodexSignInState } from "./codex-detect.ts";
import {
  DEFAULT_CODEX_BIN,
  namedSttProvider,
  resolveSttSettings,
  sttSettingsPath,
  writeSttSettingsFile,
  type SttSettingsDocument,
  type SttSettingsFileOps,
} from "./config.ts";
import { sttCapability } from "./http.ts";
import { jsonRecord, jsonStringField } from "./json.ts";
import type { SttProvider } from "./provider.ts";
import { diskSttFileOps, readSttSources, sameSttSources, type SttSources } from "./whistle-http.ts";
import type { WhistleModelStore } from "./whistle-model.ts";

// ── THE HOST'S SPEECH PROVIDER, SEEN AND CHOSEN FROM SETTINGS (ADR 0097) ─────────────────────
//
//   GET /api/stt/host   read   which provider the host runs, whether it works, who set it, and which
//                              of the three choices Settings may make right now
//   PUT /api/stt/host   write  `{ "provider": "whistle" | "codex" | "off", "consent"?: "<id>" }`
//
// Lead-local like every speech route: neither reads `?host=` and neither is in the crew's FORWARDABLE
// list. server.ts does the gating and the audit line; everything the routes decide lives here.
//
// THREE CHOICES, AND ONLY THREE. A write device may move the host between Whistle (when its model is
// ready), Codex (when the host's `codex` is installed and signed in with ChatGPT) and Off. Each of them
// carries no key and runs no command the operator chose; Codex adds the consent ADR 0029 asks for, the
// SAME words `collie stt setup` prints (bridge/stt/codex-setup.ts), accepted with a tap that sends the
// consent's id. The app NEVER replaces or removes:
//
//   • a provider set up in a terminal with a key, an endpoint or a command (`openai-compatible`,
//     `local-cli`, or a name this build does not know), because that is the operator's credential and
//     the operator's command, and those stay on the keyboard (ADR 0029);
//   • anything the deployment's environment names, because the environment wins over the file and a
//     phone cannot change it, so a write would only pretend;
//   • an `stt.json` this bridge cannot read, because overwriting it would lose it.
//
// THE CODEX SWITCH IS THE CLI'S SETUP, NOT A SHORTCUT ROUND IT. It checks the sign-in afresh, runs the
// same honest-first probe `collie stt setup` runs (`probeCodexSetup`), and writes the same document,
// identity included. A probe that fails writes nothing.
//
// RACES. One switch at a time per bridge (a Codex probe can take a while; a second PUT is told so).
// Every write re-reads `stt.json` and the environment after its last `await` and compares them with
// what it read first; anything changed is a 409 and nothing is written. The re-read and the write have
// no `await` between them, so a `collie stt setup` in a terminal is never overwritten by a tap that
// began before it. The write goes through `writeSttSettingsFile`, the one writer, with a temporary name
// unique to this write.

/** What a host route answered, and the words for its audit line. Never a path, never a reason's text. */
export interface SttHostRouteResult {
  response: Response;
  attempt: { status: number; outcome: string; provider?: string; identity?: string };
}

/** One switch at a time per bridge. */
export interface SttHostGate {
  busy: boolean;
}

export interface SttHostRouteDeps {
  stateDir: string;
  /** The bridge's environment, which may name a provider the file cannot override. */
  env: Record<string, string | undefined>;
  /** The provider the bridge runs right now: what the phone's microphone gets. */
  stt: () => Promise<SttProvider | null>;
  /** The Whistle model, which must be ready before Whistle may be chosen. */
  store: WhistleModelStore;
  /** Whether the host's `codex` is installed and signed in with ChatGPT. */
  codex: CodexDetector;
  /** The identity probe. Production leaves it: `probeCodexIdentity`, honest first. */
  probe?: CodexIdentityProbe;
  gate: SttHostGate;
  /** How `stt.json` is written and removed. The disk unless a test watches it. */
  files?: SttSettingsFileOps;
}

/**
 * The `codex` binary Settings would ask and record: the one `stt.json` already names when the codex
 * provider is set up, else `codex` found the way the CLI finds it (PATH, then the fallback directories
 * a systemd unit's minimal PATH lacks). Absolute, or null.
 */
export function locateCodexBin(stateDir: string, env: Record<string, string | undefined>): string | null {
  const { file } = readSttSources(stateDir, env);
  const named = file.provider === "codex" && file.codexBin !== undefined ? file.codexBin : DEFAULT_CODEX_BIN;
  return findTool(named, env, homedir());
}

/** A detector over {@link locateCodexBin}. One per bridge, so its cache is shared by every device. */
export function createHostCodexDetector(stateDir: string, env: Record<string, string | undefined>): CodexDetector {
  return createCodexDetector({ locate: () => locateCodexBin(stateDir, env) });
}

/** Who names the provider: the environment wins over the file, as it does in the resolve. */
function configuredBy(sources: SttSources): SttHostStatus["configuredBy"] {
  if (namedSttProvider({}, sources.env) !== undefined) return "env";
  if (sources.unreadable || namedSttProvider(sources.file, {}) !== undefined) return "file";
  return "none";
}

/** The providers a phone may replace or remove. Every other one is the operator's, set in a terminal. */
const SWITCHABLE_PROVIDERS = new Set(["whistle", "codex"]);

/** Why no choice at all may be made from Settings, or null when the three are open to their own checks. */
function lockReason(sources: SttSources): SttHostSwitchReason | null {
  if (namedSttProvider({}, sources.env) !== undefined) return "env";
  if (sources.unreadable) return "unreadable";
  const named = namedSttProvider(sources.file, {});
  if (named !== undefined && !SWITCHABLE_PROVIDERS.has(named)) return "terminal";
  return null;
}

const CODEX_REASONS = {
  missing: "codex-missing",
  "signed-out": "codex-signed-out",
  "other-login": "codex-other-login",
  unknown: "codex-unknown",
} as const satisfies Record<Exclude<CodexSignInState, "ready">, SttHostSwitchReason>;

const CODEX_CODES = {
  missing: "stt.codex_missing",
  "signed-out": "stt.codex_signed_out",
  "other-login": "stt.codex_other_login",
  unknown: "stt.codex_unknown",
} as const satisfies Record<Exclude<CodexSignInState, "ready">, ErrorCode>;

const closed = (reason: SttHostSwitchReason): SttHostSwitch => ({ ok: false, reason });
const OPEN: SttHostSwitch = { ok: true };

/** The whole status. Spawns at most one `codex login status`, and only when Codex could be chosen. */
export async function sttHostStatus(deps: SttHostRouteDeps): Promise<SttHostStatus> {
  const sources = readSttSources(deps.stateDir, deps.env);
  const warnings: string[] = [];
  const resolved = sources.unreadable ? null : resolveSttSettings(sources.file, sources.env, (m) => warnings.push(m));
  const capability = await sttCapability(await deps.stt());
  // The name the settings give, or, for an unreadable file, the provider the bridge still runs (it
  // keeps the last good settings).
  const named = sources.unreadable ? capability?.provider : namedSttProvider(sources.file, sources.env);
  const provider = named ?? capability?.provider ?? "none";

  const status: SttHostStatus = {
    provider,
    available: capability?.available ?? false,
    configuredBy: configuredBy(sources),
    switchable: { whistle: OPEN, codex: OPEN, off: OPEN },
  };
  // Assigned, never spread in as `undefined`: an available provider carries no `reason` key.
  const reason = capability?.reason ?? (provider !== "none" && capability === null ? warnings[0] : undefined);
  if (reason !== undefined) status.reason = reason;
  if (resolved?.provider === "codex") status.identity = resolved.wireIdentity;

  const lock = lockReason(sources);
  if (lock !== null) {
    status.switchable = { whistle: closed(lock), codex: closed(lock), off: closed(lock) };
    return status;
  }
  const model = await deps.store.status();
  const codex = await deps.codex.check();
  if (codex.codexBin !== undefined) status.codexBin = codex.codexBin;
  status.switchable = {
    whistle: model.state === "ready" && model.sha256 !== undefined ? OPEN : closed("not-ready"),
    codex: codex.state === "ready" ? OPEN : closed(CODEX_REASONS[codex.state]),
    off: OPEN,
  };
  return status;
}

function json(body: SttHostStatus): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function refuse(status: number, code: ErrorCode, provider: string, detail?: ApiErrorDetail): SttHostRouteResult {
  return {
    response: new Response(JSON.stringify(apiError(code, detail)), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
    attempt: { status, outcome: code, provider },
  };
}

/** `GET /api/stt/host`. */
export async function sttHostGet(deps: SttHostRouteDeps): Promise<Response> {
  return json(await sttHostStatus(deps));
}

/** The choices `PUT /api/stt/host` takes. */
export type SttHostChoice = "whistle" | "codex" | "off";

/** The body of `PUT /api/stt/host`, or null when it is not one. */
export function parseSttHostRequest(raw: JsonValue | undefined): { provider: SttHostChoice; consent?: string } | null {
  const body = jsonRecord(raw);
  if (body === null) return null;
  const provider = jsonStringField(body.provider);
  if (provider !== "whistle" && provider !== "codex" && provider !== "off") return null;
  const consent = body.consent === undefined ? undefined : jsonStringField(body.consent);
  if (consent === null) return null;
  return consent === undefined ? { provider } : { provider, consent };
}

/** `PUT /api/stt/host`. `body` is the parsed request body. */
export async function sttHostPut(deps: SttHostRouteDeps, body: JsonValue | undefined): Promise<SttHostRouteResult> {
  const request = parseSttHostRequest(body);
  if (request === null) {
    return { response: new Response("bad body", { status: 400 }), attempt: { status: 400, outcome: "invalid" } };
  }
  // Before anything else, and before the gate: a Codex switch without the consent the app showed runs
  // nothing at all, not even the sign-in check.
  if (request.provider === "codex" && request.consent !== CODEX_CONSENT_ID) {
    return refuse(400, "stt.consent_required", "codex");
  }
  if (deps.gate.busy) return refuse(409, "stt.host_busy", request.provider);
  deps.gate.busy = true;
  try {
    return await switchProvider(deps, request.provider);
  } finally {
    deps.gate.busy = false;
  }
}

async function switchProvider(deps: SttHostRouteDeps, choice: SttHostChoice): Promise<SttHostRouteResult> {
  const files = deps.files ?? diskSttFileOps;
  const before = readSttSources(deps.stateDir, deps.env);
  if (lockReason(before) !== null) return refuse(409, "stt.host_provider_locked", choice);
  const current = namedSttProvider(before.file, {});
  const done = async (outcome: string, identity?: string): Promise<SttHostRouteResult> => {
    const attempt: SttHostRouteResult["attempt"] = { status: 200, outcome, provider: choice };
    if (identity !== undefined) attempt.identity = identity;
    return { response: json(await sttHostStatus(deps)), attempt };
  };

  if (choice === "off") {
    // No await since `before` was read: the file removed is the file that was judged.
    if (current === undefined) return done("unchanged");
    files.remove(sttSettingsPath(deps.stateDir));
    return done("ok");
  }

  let document: SttSettingsDocument;
  let identity: string | undefined;
  if (choice === "whistle") {
    if ((await deps.store.ready()) === null) return refuse(409, "stt.whistle_not_ready", choice);
    document = { provider: "whistle" };
  } else {
    // Fresh, never from the cache: the answer decides whether a probe is sent with this sign-in.
    const signIn = await deps.codex.check(true);
    if (signIn.state !== "ready" || signIn.codexBin === undefined) {
      return refuse(409, CODEX_CODES[signIn.state === "ready" ? "unknown" : signIn.state], choice);
    }
    try {
      ({ document, identity } = await probeCodexSetup(signIn.codexBin, deps.probe));
    } catch (err) {
      // Collie's own sentence (codex-auth.ts and codex.ts write them), never the endpoint's body.
      return refuse(502, "stt.codex_probe_failed", choice, { reason: err instanceof Error ? err.message : String(err) });
    }
    // The CLI's acceptance test, applied here too: the document must resolve on its own.
    if (resolveSttSettings(document, {}, () => undefined) === null) {
      return refuse(502, "stt.codex_probe_failed", choice, { reason: "the probe produced settings Collie cannot use" });
    }
  }

  // The last await is behind us. Read again and refuse when anything changed; then write, with no
  // await in between.
  if (!sameSttSources(before, readSttSources(deps.stateDir, deps.env))) return refuse(409, "stt.host_changed", choice);
  if (choice === "whistle" && current === "whistle") return done("unchanged");
  writeSttSettingsFile(deps.stateDir, document, files);
  return done("ok", identity);
}
