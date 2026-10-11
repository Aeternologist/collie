import type { Host } from "../host.ts";
import { collieSelfCommand, pluginRoot } from "../root.ts";
import { childEnv, childRunner } from "./local-cli.ts";
import type { SttAudio, SttProvider, SttResult, SttStatus } from "./provider.ts";
import { createWhistleModelStore, whistleEngineInPlace } from "./whistle-model.ts";

// ── THE WHISTLE PROVIDER (ADR 0096 Decision 4) ───────────────────────────────────────────────
//
// The host engine, and the one provider that is Collie's own code. One child per dictation:
//
//     <collie> _whistle-transcribe <tempdir>/recording.wav
//
// where `<collie>` is the running binary, or Bun plus `cli/main.ts` from source (`collieSelfCommand`).
// The child reads the vendored engine and the model, checks all three against the pins in its own
// source BEFORE it compiles anything, transcribes, and prints the text (`cli/whistle-transcribe.ts`).
// A child and not a worker: a running wasm call stops for certain only when its process dies, a
// malformed file or a heap grown to 2 GiB dies with the child and not with the bridge, and the
// compiled binary has one entrypoint.
//
// Every bound is `local-cli`'s, through the same `childRunner`: argv only, a private 0700 temp dir,
// the 60 s deadline with SIGKILL on the process group (the tree on Windows), the 256 KiB stdout cap,
// the shared in-flight cap, stderr never read. What differs is who wrote the argv: Collie did, all
// of it. Nothing in `stt.json` but the provider's name, and nothing from a request but the bytes.
//
// THE ENVIRONMENT. No `COLLIE_*` variable of the bridge's is passed down, as for local-cli. Two are
// then SET, to values the bridge resolved itself, not copied from its environment:
// `COLLIE_STATE_DIR` (where the model is) and `COLLIE_PLUGIN_ROOT` (where the engine is). The child
// reads them through the same resolvers the rest of Collie uses (`resolveStateDir`, `pluginRoot`),
// so it finds exactly the files this bridge checked in `status()`, under an instance with its own
// state dir or a binary kept outside its checkout. They travel in the environment rather than as
// arguments so the argv stays the fixed three words the ADR names; neither is a secret.

/** The hidden verb the child runs. */
export const WHISTLE_VERB = "_whistle-transcribe";

/** The longest recording this provider takes: 4 minutes of 16 kHz 16-bit mono fits the 8 MiB cap. */
export const WHISTLE_MAX_DURATION_MS = 240_000;

export interface WhistleProviderDeps {
  stateDir: string;
  /** The checkout root the engine is read from. {@link pluginRoot} unless a test names one. */
  root?: string;
  /** The argv prefix that runs this Collie's CLI. {@link collieSelfCommand} unless a test fakes the child. */
  self?: readonly string[];
  /** The bridge's environment, before `COLLIE_*` is dropped. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  tmpRoot?: string;
  host?: Host;
}

/** The child's environment: the bridge's minus every `COLLIE_*`, plus the two the child needs. */
export function whistleChildEnv(source: Record<string, string | undefined>, stateDir: string, root: string) {
  return { ...childEnv(source), COLLIE_STATE_DIR: stateDir, COLLIE_PLUGIN_ROOT: root };
}

export function createWhistleSttProvider(deps: WhistleProviderDeps): SttProvider {
  const root = deps.root ?? pluginRoot();
  const self = [...(deps.self ?? collieSelfCommand())];
  // Only ever asked whether the model is ready; this provider never downloads, so no version is needed.
  const model = createWhistleModelStore({ stateDir: deps.stateDir, version: "" });
  const run = childRunner({
    env: whistleChildEnv(deps.env ?? process.env, deps.stateDir, root),
    noun: "the Whistle engine",
    timeoutMs: deps.timeoutMs,
    tmpRoot: deps.tmpRoot,
    host: deps.host,
  });

  return {
    id: "whistle",
    input: "wav-16k",
    maxDurationMs: WHISTLE_MAX_DURATION_MS,

    /**
     * Available only when the model is held with an accepted hash and the engine files are in place
     * at their pinned sizes. Stat-cheap after the first hash (`whistle-model.ts` caches it).
     */
    async status(): Promise<SttStatus> {
      if ((await model.ready()) === null) return { available: false, reason: "the Whistle model is not on the host" };
      if (!whistleEngineInPlace(root)) return { available: false, reason: "the Whistle engine files are missing from this install" };
      return { available: true };
    },

    transcribe(input: SttAudio, signal?: AbortSignal): Promise<SttResult> {
      // The route has already checked the WAV header (bridge/stt/http.ts); the name is Collie's own.
      return run((path) => [...self, WHISTLE_VERB, path], "recording.wav", input, signal);
    },
  };
}
