import type { PhoneEngineBlock, SttEngineChoice } from "@/lib/stt";
import type { StoredModel } from "@/lib/stt-model";
import type { SttCapability, SttHostChoice, SttHostStatus, WhistleStatus } from "@/lib/types";

// ── SETTINGS → VOICE, THE FACTS BEHIND THE WORDS ────────────────────────────────────────────────
//
// Pure rules the Voice pages draw from (components/speech-control.tsx). No store, no network, no
// words: each answer is a code the page turns into a sentence from the catalogue, so a test can pin
// the rule without a screen.
//
// THE FIVE HOST OPTIONS, in the order audio travels: Whistle on the host, a command on the host, a
// speech service off the host, the ChatGPT subscription off the host, then Off. The bridge names them
// by provider (`whistle`, `local-cli`, `openai-compatible`, `codex`, `none`); the page names them by
// what they do. Settings switches three of them (Whistle, ChatGPT, Off, ADR 0097); the other two are
// set up in a terminal on the host.

/** The host's option, as Settings → Voice names it. */
export type HostOption = "whistle" | "command" | "service" | "chatgpt" | "off";

/** Every host option, in the order audio travels. Off last, on its own. */
export const HOST_OPTIONS = ["whistle", "command", "service", "chatgpt", "off"] as const satisfies readonly HostOption[];

/** Where audio goes, one fixed sentence each. `nowhere`: the host takes none. */
export type Reach = "phone" | "host" | "command" | "service" | "chatgpt" | "nowhere";

/** The option a provider id means, or `null` for a name this build does not know. */
export function hostOptionOf(provider: string): HostOption | null {
  switch (provider) {
    case "whistle":
      return "whistle";
    case "local-cli":
      return "command";
    case "openai-compatible":
      return "service";
    case "codex":
      return "chatgpt";
    case "none":
      return "off";
    default:
      return null;
  }
}

/** The choice `PUT /api/stt/host` takes for an option, or `null` for the two set up in a terminal. */
export function choiceOf(option: HostOption): SttHostChoice | null {
  switch (option) {
    case "whistle":
      return "whistle";
    case "chatgpt":
      return "codex";
    case "off":
      return "off";
    case "command":
    case "service":
      return null;
  }
}

/** The option a choice selects. */
export function optionOfChoice(choice: SttHostChoice): HostOption {
  return choice === "codex" ? "chatgpt" : choice;
}

export function reachOf(option: HostOption): Reach {
  switch (option) {
    case "whistle":
      return "host";
    case "off":
      return "nowhere";
    default:
      return option;
  }
}

/** Audio that leaves the host's network: it carries the icon-and-word marker, never a colour alone. */
export function leavesNetwork(reach: Reach): boolean {
  return reach === "service" || reach === "chatgpt";
}

/** The tier an option is listed under. `null`: Off, which stands alone below both. */
export function tierOf(option: HostOption): "stays" | "leaves" | null {
  if (option === "off") return null;
  return leavesNetwork(reachOf(option)) ? "leaves" : "stays";
}

/** The host's option right now: the status read when there is one, else the config's provider. */
export function currentHostProvider(host: SttHostStatus | null, hostStt: SttCapability | null): string {
  return host?.provider ?? hostStt?.provider ?? "none";
}

/** How far audio travels, for "does this change need a word first": a step toward less travel does not. */
const TRAVEL = { off: 0, whistle: 1, command: 2, service: 3, chatgpt: 4 } as const satisfies Record<HostOption, number>;

/**
 * What a tap on a host choice asks for before anything is sent: nothing, the host-wide confirm, or the
 * ChatGPT consent. ChatGPT always asks for consent (ADR 0097). Any other choice asks only when it sends
 * audio further than the option it replaces; a step back toward the host is sent on the tap. A host
 * whose option is not known yet (`null`) counts as Off.
 */
export function askFor(from: HostOption | null, to: SttHostChoice): "none" | "confirm" | "consent" {
  if (to === "codex") return "consent";
  return TRAVEL[optionOfChoice(to)] > TRAVEL[from ?? "off"] ? "confirm" : "none";
}

// ── "WHEN YOU PRESS THE MIC" ────────────────────────────────────────────────────────────────────

/** The state word's look. `works` and `setup` are fine or new; `paused` and `broken` need a person. */
export type VoiceState = "works" | "setup" | "paused" | "broken";

/**
 * What the status card says, as codes. `where` names who turns speech into text; `reach` is where
 * audio goes (`null`: nothing is recorded); `action` is the one thing that fixes the state.
 */
export type VoiceStatus =
  | { kind: "phone"; state: "works"; reach: "phone" }
  | { kind: "paused"; state: "paused"; reach: null; action: "restore" | null }
  | { kind: "setup"; state: "setup"; reach: null }
  | { kind: "no-recording"; state: "broken"; reach: null }
  | { kind: "host"; state: "works" | "broken"; option: HostOption | null; provider: string; reach: Reach | null; action: "fix" | null };

export interface VoiceStatusInput {
  /** What this device asked for. */
  engine: SttEngineChoice;
  /** The phone's own copy: `null` none, `undefined` still looking. */
  local: StoredModel | null | undefined;
  /** Why "On this phone" cannot run, if it cannot. */
  block: PhoneEngineBlock | null;
  /** The host's provider id (`none` when it has none). */
  provider: string;
  /** Whether the host's provider could serve a request now. */
  available: boolean;
  /** The host's model, which a lost phone copy is restored from. */
  whistle: WhistleStatus | null;
  /** This browser can record at all. */
  recording: boolean;
}

/** The browser's own reason "On this phone" cannot run, or `null`. A host not ready is not one. */
export function browserBlock(block: PhoneEngineBlock | null): Exclude<PhoneEngineBlock, "host-not-ready"> | null {
  return block === null || block === "host-not-ready" ? null : block;
}

/**
 * Which of this phone's two choices is in force. "On this phone" is in force while the device asked
 * for it and this browser can run it; a copy that is gone does not move the choice to the host (ADR
 * 0096 Decision 12): the choice stays, and dictation is paused until the copy is back or the person
 * chooses the host. A browser that cannot run the engine at all is the one case that reads as the
 * host, because "On this phone" was never available there (ADR 0096 Decision 8).
 */
export function phoneChoiceInForce(engine: SttEngineChoice, block: PhoneEngineBlock | null): SttEngineChoice {
  return engine === "phone" && browserBlock(block) === null ? "phone" : "host";
}

/** What happens when the mic is pressed, from the same facts the composer reads. */
export function voiceStatus(input: VoiceStatusInput): VoiceStatus {
  if (!input.recording) return { kind: "no-recording", state: "broken", reach: null };
  if (phoneChoiceInForce(input.engine, input.block) === "phone") {
    if (input.local === null) {
      const restorable = input.whistle?.state === "ready";
      return { kind: "paused", state: "paused", reach: null, action: restorable ? "restore" : null };
    }
    return { kind: "phone", state: "works", reach: "phone" };
  }
  const option = hostOptionOf(input.provider);
  if (option === "off") return { kind: "setup", state: "setup", reach: null };
  const reach = option === null ? null : reachOf(option);
  if (!input.available) return { kind: "host", state: "broken", option, provider: input.provider, reach, action: "fix" };
  return { kind: "host", state: "works", option, provider: input.provider, reach, action: null };
}

// ── THE MODEL ROW'S CHIP ────────────────────────────────────────────────────────────────────────

/** The model's state in one or two words, for the hub's row. */
export type ModelChip = "gone" | "update" | "downloading" | "failed" | "absent" | "both" | "host" | "phone";

export function modelChip(input: {
  whistle: WhistleStatus | null;
  local: StoredModel | null | undefined;
  /** "On this phone" is in force, so a missing copy is a paused phone rather than a step not taken. */
  phoneInForce: boolean;
}): ModelChip {
  const { whistle, local, phoneInForce } = input;
  const held = local !== null && local !== undefined;
  if (!held && phoneInForce && local === null) return "gone";
  if (held && whistle?.state === "ready" && whistle.sha256 !== undefined && whistle.sha256 !== local.sha256) return "update";
  if (whistle?.state === "downloading") return "downloading";
  if (whistle?.state === "failed" && !held) return "failed";
  if (whistle?.state === "ready") return held ? "both" : "host";
  if (held) return "phone";
  return "absent";
}
