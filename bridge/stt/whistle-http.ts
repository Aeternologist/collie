import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

import { apiError, type ApiErrorDetail, type ErrorCode } from "../error-codes.ts";
import type { JsonValue } from "../json.ts";
import type { WhistleStatus } from "../types.ts";
import {
  coerceSttFile,
  namedSttProvider,
  sttEnvSettings,
  sttSettingsPath,
  writeSttSettingsFile,
  type SttSettingsFileOps,
} from "./config.ts";
import { jsonBooleanField, jsonRecord } from "./json.ts";
import type { WhistleModelStore } from "./whistle-model.ts";

// ── THE WHISTLE ROUTES' OWN RULES, AWAY FROM Bun.serve (ADR 0096) ───────────────────────────
//
//   GET    /api/stt/whistle         read   the model's state and the host engine's switch
//   POST   /api/stt/whistle         write  start the download, or join the one in flight
//   DELETE /api/stt/whistle         write  remove the model, and the `whistle` provider if it is set
//   PUT    /api/stt/whistle/host    write  `{ "on": boolean }`, the host engine's switch
//   GET    /api/stt/model/<sha256>  read   the model's bytes, content-addressed
//
// All lead-local: none is in the crew's FORWARDABLE list and none reads `?host=`, exactly like
// `/api/stt`, because speech is lead-only (ADR 0029). server.ts does the gating and the audit line;
// everything the routes decide lives here so `bun test` can drive it.
//
// THE SWITCH IS NOT A SETUP FORM (ADR 0096 Decision 3). It writes one document, `{ "provider":
// "whistle" }`, through the same writer `collie stt setup` uses, and only when nothing else is
// configured: a provider the operator chose in the terminal (a key, a command, an endpoint) is never
// replaced or removed from a phone, and neither is an `stt.json` this bridge cannot read, nor a
// provider the deployment's environment names. The bridge picks the change up without a restart,
// because the gate re-reads `stt.json` behind an mtime check on every request (bridge/stt/index.ts).

/** What a whistle route answered, and the words for its audit line. Never a path, never the model. */
export interface WhistleRouteResult {
  response: Response;
  attempt: { status: number; outcome: string; on?: boolean };
}

export interface WhistleRouteDeps {
  store: WhistleModelStore;
  stateDir: string;
  /** The bridge's environment, which may name a provider the file cannot override. */
  env: Record<string, string | undefined>;
  /** How `stt.json` is written and removed. The disk unless a test watches it. */
  files?: SttSettingsFileOps;
}

/** The disk, for {@link writeSttSettingsFile}. The temporary is created exclusively, never written through. */
export const diskSttFileOps: SttSettingsFileOps = {
  mkdirp: (path, mode) => mkdirSync(path, { recursive: true, mode }),
  write: (path, text, mode) => {
    rmSync(path, { force: true });
    writeFileSync(path, text, { mode, flag: "wx" });
  },
  rename: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path, { force: true }),
};

/** Who holds the host's speech-to-text setting, as far as Settings is concerned. */
interface HostFlags {
  hostEngine: boolean;
  hostTaken: boolean;
  /** The file names `whistle` and the environment names nothing: a phone may turn it off. */
  removable: boolean;
}

/**
 * Read `stt.json` and the environment, before any resolve. A file that is there and cannot be read
 * or parsed is the operator's (taken), never "nothing configured": overwriting it would lose it.
 */
function hostFlags(deps: WhistleRouteDeps): HostFlags {
  let file = coerceSttFile(undefined);
  let unreadable = false;
  let text: string | null = null;
  try {
    text = readFileSync(sttSettingsPath(deps.stateDir), "utf8");
  } catch (err) {
    unreadable = !(err instanceof Error && "code" in err && err.code === "ENOENT");
  }
  if (text !== null) {
    try {
      // SAFETY: `JSON.parse` answers with a JSON value and `coerceSttFile` checks every field it reads.
      file = coerceSttFile(JSON.parse(text) as JsonValue);
    } catch {
      unreadable = true;
    }
  }
  const env = sttEnvSettings(deps.env);
  if (unreadable) return { hostEngine: false, hostTaken: true, removable: false };
  const effective = namedSttProvider(file, env);
  return {
    hostEngine: effective === "whistle",
    hostTaken: effective !== undefined && effective !== "whistle",
    removable: namedSttProvider(file, {}) === "whistle" && namedSttProvider({}, env) === undefined,
  };
}

/** The whole `WhistleStatus`: the store's half and the switch's half. `/api/config` carries this too. */
export async function whistleStatus(deps: WhistleRouteDeps): Promise<WhistleStatus> {
  const model = await deps.store.status();
  const { hostEngine, hostTaken } = hostFlags(deps);
  return { ...model, hostEngine, hostTaken };
}

function json(body: WhistleStatus, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function refuse(status: number, code: ErrorCode, detail?: ApiErrorDetail): WhistleRouteResult {
  return {
    response: new Response(JSON.stringify(apiError(code, detail)), { status, headers: { "content-type": "application/json; charset=utf-8" } }),
    attempt: { status, outcome: code },
  };
}

/** `GET /api/stt/whistle`. */
export async function whistleGet(deps: WhistleRouteDeps): Promise<Response> {
  return json(await whistleStatus(deps), 200);
}

/** `POST /api/stt/whistle`: 202 while it downloads (begun or joined), 200 when the model is already there. */
export async function whistleStart(deps: WhistleRouteDeps): Promise<WhistleRouteResult> {
  const start = await deps.store.start();
  if (start.outcome === "refused") return refuse(500, "stt.whistle_download_failed", { reason: start.reason });
  const status = start.outcome === "ready" ? 200 : 202;
  return { response: json(await whistleStatus(deps), status), attempt: { status, outcome: start.outcome } };
}

/** `DELETE /api/stt/whistle`: the model goes, and so does the `whistle` provider when a phone may remove it. */
export async function whistleRemove(deps: WhistleRouteDeps): Promise<WhistleRouteResult> {
  await deps.store.remove();
  if (hostFlags(deps).removable) (deps.files ?? diskSttFileOps).remove(sttSettingsPath(deps.stateDir));
  return { response: json(await whistleStatus(deps), 200), attempt: { status: 200, outcome: "removed" } };
}

/** The body of `PUT /api/stt/whistle/host`, or null when it is not `{ "on": boolean }`. */
export function parseWhistleHost(raw: JsonValue | undefined): { on: boolean } | null {
  const on = jsonBooleanField(jsonRecord(raw)?.on);
  return on === null ? null : { on };
}

/** `PUT /api/stt/whistle/host`. `body` is the parsed request body. */
export async function whistleHost(deps: WhistleRouteDeps, body: JsonValue | undefined): Promise<WhistleRouteResult> {
  const request = parseWhistleHost(body);
  if (request === null) {
    return { response: new Response("bad body", { status: 400 }), attempt: { status: 400, outcome: "invalid" } };
  }
  const flags = hostFlags(deps);
  const files = deps.files ?? diskSttFileOps;
  if (request.on) {
    if (flags.hostTaken) return { ...refuse(409, "stt.whistle_provider_taken"), attempt: { status: 409, outcome: "taken", on: true } };
    if ((await deps.store.ready()) === null) return { ...refuse(409, "stt.whistle_not_ready"), attempt: { status: 409, outcome: "not-ready", on: true } };
    if (!flags.hostEngine) writeSttSettingsFile(deps.stateDir, { provider: "whistle" }, files);
  } else if (flags.hostEngine) {
    // On, but from the environment: the deployment's statement, which no phone may change.
    if (!flags.removable) return { ...refuse(409, "stt.whistle_provider_taken"), attempt: { status: 409, outcome: "taken", on: false } };
    files.remove(sttSettingsPath(deps.stateDir));
  } else if (flags.hostTaken) {
    return { ...refuse(409, "stt.whistle_provider_taken"), attempt: { status: 409, outcome: "taken", on: false } };
  }
  return { response: json(await whistleStatus(deps), 200), attempt: { status: 200, outcome: "ok", on: request.on } };
}

/** The policy on the model's bytes: nothing in them may run, whatever a browser makes of them. */
export const MODEL_CSP = "default-src 'none'; sandbox";

/**
 * `GET /api/stt/model/<sha256>` (ADR 0096 Decision 9). The hash in the path is COMPARED, never joined
 * into a path: the file served is always the one at the fixed model path, and only when the bytes
 * read for this answer hash to exactly the asked value, and that value is one this build accepts.
 *
 * The bytes are read into memory and hashed for each answer rather than streamed from the file:
 * Bun answers a `Range` request on any file-backed body by itself, and this route serves whole
 * copies only. A phone copies the model once, so 17 MB and one hash per copy is the price of that.
 */
export async function modelResponse(deps: Pick<WhistleRouteDeps, "store">, asked: string): Promise<WhistleRouteResult> {
  const unknown = (): WhistleRouteResult => refuse(404, "stt.model_unknown");
  if (!/^[0-9a-f]{64}$/.test(asked)) return unknown();
  // `ready()` is null unless the held file's hash is one this build accepts.
  const ready = await deps.store.ready();
  if (ready === null || ready.sha256 !== asked) return unknown();
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(await Bun.file(ready.path).arrayBuffer());
  } catch {
    return unknown();
  }
  if (createHash("sha256").update(bytes).digest("hex") !== asked) return unknown();
  return {
    response: new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.byteLength),
        etag: `"${asked}"`,
        // The phone keeps its own copy in Cache Storage; the HTTP cache should not keep a second one.
        "cache-control": "no-store",
        "content-security-policy": MODEL_CSP,
        "accept-ranges": "none",
      },
    }),
    attempt: { status: 200, outcome: "ok" },
  };
}
