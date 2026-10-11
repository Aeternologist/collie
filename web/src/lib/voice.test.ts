import { describe, expect, it } from "vitest";

import type { WhistleStatus } from "@/lib/types";
import { askFor, hostOptionOf, modelChip, phoneChoiceInForce, tierOf, voiceStatus, type VoiceStatusInput } from "./voice";

// The pure rules behind Settings → Voice (lib/voice.ts). The pages' words are pinned in
// components/speech-control.test.tsx; here only the decisions.

const READY: WhistleStatus = { state: "ready", bytes: 1, hostEngine: true, hostTaken: false, sha256: "a".repeat(64) };
const COPY = { sha256: "a".repeat(64), bytes: 1 };

describe("the host's options", () => {
  it.each([
    ["whistle", "whistle"],
    ["local-cli", "command"],
    ["openai-compatible", "service"],
    ["codex", "chatgpt"],
    ["none", "off"],
    ["something-new", null],
  ])("%s is %s", (provider, option) => {
    expect(hostOptionOf(provider)).toBe(option);
  });

  it("lists a command under the machines it stays on, and Off under neither tier", () => {
    expect(tierOf("command")).toBe("stays");
    expect(tierOf("service")).toBe("leaves");
    expect(tierOf("chatgpt")).toBe("leaves");
    expect(tierOf("off")).toBeNull();
  });
});

describe("askFor: what a tap asks before anything is sent", () => {
  it("ChatGPT always asks for consent, even from another option that leaves the host", () => {
    expect(askFor("off", "codex")).toBe("consent");
    expect(askFor("service", "codex")).toBe("consent");
  });

  it("asks for the host-wide confirm when audio would travel further", () => {
    expect(askFor("off", "whistle")).toBe("confirm");
    expect(askFor(null, "whistle")).toBe("confirm");
  });

  it("sends a step back toward the host on the tap", () => {
    expect(askFor("whistle", "off")).toBe("none");
    expect(askFor("chatgpt", "whistle")).toBe("none");
    expect(askFor("service", "off")).toBe("none");
  });
});

describe("voiceStatus: what happens when the mic is pressed", () => {
  const base: VoiceStatusInput = {
    engine: "host",
    local: null,
    block: null,
    provider: "whistle",
    available: true,
    whistle: READY,
    recording: true,
  };

  it("no recording in this browser is broken, whatever else is set", () => {
    expect(voiceStatus({ ...base, recording: false })).toMatchObject({ kind: "no-recording", state: "broken" });
  });

  it("this phone with its copy works on the phone", () => {
    expect(voiceStatus({ ...base, engine: "phone", local: COPY })).toEqual({ kind: "phone", state: "works", reach: "phone" });
  });

  it("this phone without its copy is paused, never the host", () => {
    expect(voiceStatus({ ...base, engine: "phone" })).toEqual({ kind: "paused", state: "paused", reach: null, action: "restore" });
    expect(voiceStatus({ ...base, engine: "phone", whistle: null })).toMatchObject({ kind: "paused", action: null });
  });

  it("a browser that cannot run the engine reads as the host", () => {
    expect(phoneChoiceInForce("phone", "insecure")).toBe("host");
    expect(phoneChoiceInForce("phone", "host-not-ready")).toBe("phone");
    expect(voiceStatus({ ...base, engine: "phone", block: "insecure" })).toMatchObject({ kind: "host", state: "works" });
  });

  it("the host with no option needs setup; an option that does not answer is broken, with Fix", () => {
    expect(voiceStatus({ ...base, provider: "none", available: false })).toMatchObject({ kind: "setup" });
    expect(voiceStatus({ ...base, provider: "codex", available: false })).toMatchObject({
      kind: "host",
      state: "broken",
      option: "chatgpt",
      reach: "chatgpt",
      action: "fix",
    });
  });
});

describe("modelChip", () => {
  it.each([
    [{ whistle: READY, local: null, phoneInForce: true }, "gone"],
    [{ whistle: READY, local: { ...COPY, sha256: "b".repeat(64) }, phoneInForce: true }, "update"],
    [{ whistle: READY, local: COPY, phoneInForce: false }, "both"],
    [{ whistle: READY, local: null, phoneInForce: false }, "host"],
    [{ whistle: null, local: COPY, phoneInForce: false }, "phone"],
    [{ whistle: { ...READY, state: "downloading" as const }, local: null, phoneInForce: false }, "downloading"],
    [{ whistle: { ...READY, state: "failed" as const }, local: null, phoneInForce: false }, "failed"],
    [{ whistle: null, local: null, phoneInForce: false }, "absent"],
  ])("%j is %s", (input, chip) => {
    expect(modelChip(input)).toBe(chip);
  });
});
