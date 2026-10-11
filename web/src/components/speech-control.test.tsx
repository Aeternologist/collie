import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetOperatorCommands } from "@/lib/operator-config";
import { __resetSttEngine, sttEnginePreference } from "@/lib/stt";
import * as sttModel from "@/lib/stt-model";
import { dateTime } from "@/lib/format";
import { CODEX_CONSENT_ID } from "@/lib/stt-consent";
import type { SttCapability, SttHostStatus, WhistleStatus } from "@/lib/types";
import { server } from "@/test/setup";
import { SpeechCards, SpeechControl, type SpeechCardsProps } from "./speech-control";

// The probe starts a real worker; its own test is stt.test.ts. Here it only has to be asked.
vi.mock("@/lib/stt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stt")>()),
  runSttProbe: vi.fn(async () => {}),
}));

vi.mock("@/lib/stt-model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stt-model")>()),
  storedModel: vi.fn(async () => null),
  modelPersisted: vi.fn(async () => false),
  downloadModel: vi.fn(),
  removeModel: vi.fn(async () => {}),
}));

const SHA = "b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb";
const REVISION = "ca5287601bef25af26dcf2e1b2bdc0843a7c19e5";
const FETCHED_AT = "2026-10-11T09:30:00.000Z";
const BYTES = 16_919_407;

const ABSENT: WhistleStatus = { state: "absent", bytes: BYTES, hostEngine: false, hostTaken: false };
const READY: WhistleStatus = { ...ABSENT, state: "ready", sha256: SHA, revision: REVISION, fetchedAt: FETCHED_AT };
const HOST_WHISTLE: SttCapability = { provider: "whistle", available: true };
const COPY = { sha256: SHA, bytes: BYTES, revision: REVISION };

const CODEX_BIN = "/home/op/.local/bin/codex";
/** The host with no provider, Whistle not downloaded yet, Codex installed but signed out. */
const HOST_NONE: SttHostStatus = {
  provider: "none",
  available: false,
  configuredBy: "none",
  codexBin: CODEX_BIN,
  switchable: {
    whistle: { ok: false, reason: "not-ready" },
    codex: { ok: false, reason: "codex-signed-out" },
    off: { ok: true },
  },
};
const OPEN_ALL: SttHostStatus["switchable"] = { whistle: { ok: true }, codex: { ok: true }, off: { ok: true } };
const HOST_WHISTLE_ON: SttHostStatus = { ...HOST_NONE, provider: "whistle", available: true, configuredBy: "file", switchable: OPEN_ALL };
const HOST_CODEX_ON: SttHostStatus = { ...HOST_WHISTLE_ON, provider: "codex", identity: "honest" };
const LOCKED = (reason: "terminal" | "env" | "unreadable"): SttHostStatus["switchable"] => ({
  whistle: { ok: false, reason },
  codex: { ok: false, reason },
  off: { ok: false, reason },
});
const HOST_KEYED: SttHostStatus = {
  provider: "openai-compatible",
  available: true,
  configuredBy: "file",
  switchable: LOCKED("terminal"),
};

function props(over: Partial<SpeechCardsProps> = {}): SpeechCardsProps {
  return {
    whistle: ABSENT,
    hostStt: null,
    host: null,
    switching: null,
    providerError: null,
    consentOpen: false,
    consentError: null,
    canWrite: true,
    engine: "host",
    block: null,
    local: null,
    persisted: false,
    copy: null,
    hostError: null,
    phoneError: null,
    hostBusy: false,
    confirmingRemove: false,
    onEngine: vi.fn(),
    onSetup: vi.fn(),
    onAskRemove: vi.fn(),
    onCancelRemove: vi.fn(),
    onRemove: vi.fn(),
    onChooseProvider: vi.fn(),
    onAcceptConsent: vi.fn(),
    onCancelConsent: vi.fn(),
    onPhoneDownload: vi.fn(),
    onPhoneRemove: vi.fn(),
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SpeechCards, the credit", () => {
  it("draws nothing where the host offers no Whistle and the phone holds no copy", () => {
    const { container } = render(<SpeechCards {...props({ whistle: null })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names Cactus Compute and links to them, in a new tab with no opener", () => {
    render(<SpeechCards {...props()} />);
    expect(screen.getByText(/Whistle is a speech model by/)).toBeInTheDocument();
    const maker = screen.getByRole("link", { name: "Cactus Compute" });
    expect(maker).toHaveAttribute("href", "https://cactuscompute.com");
    expect(maker).toHaveAttribute("target", "_blank");
    expect(maker.getAttribute("rel")?.split(" ").toSorted()).toEqual(["noopener", "noreferrer"]);
  });

  it("states the licence and links to the model page on Hugging Face", () => {
    render(<SpeechCards {...props()} />);
    expect(screen.getByText(/Released under the Apache 2\.0 licence\./)).toBeInTheDocument();
    const page = screen.getByRole("link", { name: "Model page on Hugging Face" });
    expect(page).toHaveAttribute("href", "https://huggingface.co/Cactus-Compute/whistle");
    expect(page).toHaveAttribute("target", "_blank");
    expect(page.getAttribute("rel")?.split(" ").toSorted()).toEqual(["noopener", "noreferrer"]);
  });

  it("puts the credit before the host step and the host step before the engine card", () => {
    render(<SpeechCards {...props({ whistle: READY })} />);
    const credit = screen.getByText(/Whistle is a speech model by/);
    const host = screen.getByRole("heading", { name: "On your host" });
    const phone = screen.getByRole("heading", { name: "On this phone" });
    const engine = screen.getByRole("radiogroup", { name: "Speech engine" });
    const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(credit, host)).toBe(true);
    expect(follows(host, phone)).toBe(true);
    expect(follows(phone, engine)).toBe(true);
  });
});

describe("SpeechCards, the host step", () => {
  it("absent: a write device sees Download to host with the size and one line, and taps it", async () => {
    const onSetup = vi.fn();
    render(<SpeechCards {...props({ onSetup })} />);
    expect(screen.getByText("Your host downloads the model once from Hugging Face. Your phones copy it from your host.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Download to host (16.9 MB)" }));
    expect(onSetup).toHaveBeenCalledTimes(1);
  });

  it("absent: a read-only device sees the sentence and no button", () => {
    render(<SpeechCards {...props({ canWrite: false })} />);
    expect(screen.getByText("A device with write access can set this up.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download to host/ })).toBeNull();
  });

  it("downloading: a determinate bar from received over bytes", () => {
    render(<SpeechCards {...props({ whistle: { ...ABSENT, state: "downloading", received: Math.round(BYTES / 2) } })} />);
    const bar = screen.getByRole("progressbar", { name: "Model download progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("8.5 MB of 16.9 MB")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download to host/ })).toBeNull();
  });

  it("failed: the reason and Try again", async () => {
    const onSetup = vi.fn();
    render(<SpeechCards {...props({ whistle: { ...ABSENT, state: "failed", reason: "Hugging Face answered 503." }, onSetup })} />);
    expect(screen.getByText("The download failed.")).toBeInTheDocument();
    expect(screen.getByText("Hugging Face answered 503.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onSetup).toHaveBeenCalledTimes(1);
  });

  it("ready: the details name the model, its size and a short checksum with the full one on hover", () => {
    render(<SpeechCards {...props({ whistle: READY })} />);
    const host = screen.getByRole("region", { name: "On your host" });
    expect(within(host).getByText("Model").nextElementSibling).toHaveTextContent("Whistle");
    expect(within(host).getByText("Size").nextElementSibling).toHaveTextContent("16.9 MB");
    const checksum = within(host).getByText("sha256 b6e02f04…");
    expect(checksum).toHaveAttribute("title", SHA);
  });

  it("ready: the version is the first seven characters of the revision, linked to that revision", () => {
    render(<SpeechCards {...props({ whistle: READY })} />);
    const host = screen.getByRole("region", { name: "On your host" });
    const version = within(host).getByRole("link", { name: "Version ca52876 on Hugging Face" });
    expect(version).toHaveTextContent("ca52876");
    expect(version).toHaveAttribute("href", `https://huggingface.co/Cactus-Compute/whistle/tree/${REVISION}`);
    expect(version).toHaveAttribute("target", "_blank");
    expect(version.getAttribute("rel")?.split(" ").toSorted()).toEqual(["noopener", "noreferrer"]);
  });

  it("ready: says when the host downloaded it, with the app's own date helper", () => {
    render(<SpeechCards {...props({ whistle: READY })} />);
    const host = screen.getByRole("region", { name: "On your host" });
    expect(within(host).getByText("Downloaded").nextElementSibling).toHaveTextContent(dateTime(Date.parse(FETCHED_AT)));
  });

  it("ready: a host that names no revision or time shows the hash prefix and no Downloaded row", () => {
    const { revision: _revision, fetchedAt: _fetchedAt, ...bare } = READY;
    render(<SpeechCards {...props({ whistle: bare })} />);
    const host = screen.getByRole("region", { name: "On your host" });
    expect(within(host).getByText("Version").nextElementSibling).toHaveTextContent("b6e02f0");
    expect(within(host).queryByRole("link")).toBeNull();
    expect(within(host).queryByText("Downloaded")).toBeNull();
  });

  it("ready: a revision that is not a full commit hash is shown, but never made a link", () => {
    render(<SpeechCards {...props({ whistle: { ...READY, revision: "rev1" } })} />);
    const host = screen.getByRole("region", { name: "On your host" });
    expect(within(host).getByText("Version").nextElementSibling).toHaveTextContent("rev1");
    expect(within(host).queryByRole("link")).toBeNull();
  });

  it("ready: Remove from host takes two taps", async () => {
    const onAskRemove = vi.fn();
    const { rerender } = render(<SpeechCards {...props({ whistle: READY, onAskRemove })} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove from host" }));
    expect(onAskRemove).toHaveBeenCalledTimes(1);

    const onRemove = vi.fn();
    const onCancelRemove = vi.fn();
    rerender(<SpeechCards {...props({ whistle: READY, confirmingRemove: true, onRemove, onCancelRemove })} />);
    expect(screen.getByText(/Remove the model from your host\?/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancelRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("ready: a read-only device sees the details but cannot remove", () => {
    render(<SpeechCards {...props({ whistle: READY, canWrite: false })} />);
    expect(screen.getByText("sha256 b6e02f04…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove from host" })).toBeNull();
  });

  it("ready: the Whistle card has no host switch any more; the choice lives in the Host speech provider card", () => {
    render(<SpeechCards {...props({ whistle: READY, host: HOST_NONE })} />);
    const host = screen.getByRole("region", { name: "On your host" });
    expect(within(host).queryByRole("switch")).toBeNull();
    expect(within(host).queryByRole("radio")).toBeNull();
    expect(screen.getByRole("radiogroup", { name: "Host speech provider" })).toBeInTheDocument();
  });

  it("shows a failed host action in words", () => {
    render(<SpeechCards {...props({ whistle: READY, hostError: "Whistle could not be downloaded: disk full" })} />);
    expect(screen.getByText("Whistle could not be downloaded: disk full")).toBeInTheDocument();
  });
});

describe("SpeechCards, the Host speech provider", () => {
  const group = () => screen.getByRole("radiogroup", { name: "Host speech provider" });
  const detail = (label: string) => screen.getByText(label, { selector: "dt" }).nextElementSibling;

  it("is not drawn while the host has not said (an older bridge)", () => {
    render(<SpeechCards {...props({ whistle: READY, host: null })} />);
    expect(screen.queryByText("Host speech provider")).toBeNull();
  });

  it("is drawn even where the Whistle cards are not", () => {
    render(<SpeechCards {...props({ whistle: null, host: HOST_KEYED })} />);
    expect(screen.getByText("Host speech provider")).toBeInTheDocument();
    expect(screen.queryByText("Speech engine")).toBeNull();
  });

  it("nothing on the host: Off is chosen, and each closed choice says why and what to run there", () => {
    render(<SpeechCards {...props({ host: HOST_NONE })} />);
    expect(detail("Provider")).toHaveTextContent("None");
    expect(detail("Status")).toHaveTextContent("Off. The host turns no recording into text.");
    expect(within(group()).getByRole("radio", { name: /^Off/ })).toHaveAttribute("aria-checked", "true");
    expect(within(group()).getByRole("radio", { name: /^Whistle/ })).toBeDisabled();
    expect(screen.getByText("Download Whistle to your host first.")).toBeInTheDocument();
    expect(within(group()).getByRole("radio", { name: /^Codex \(ChatGPT sign-in\)/ })).toBeDisabled();
    expect(screen.getByText("Codex is not signed in on your host. Run this there:")).toBeInTheDocument();
    expect(screen.getByText("codex login")).toBeInTheDocument();
    // The terminal-only providers: the command, never a form.
    expect(screen.getByText("Set up elsewhere")).toBeInTheDocument();
    expect(screen.getByText("collie stt setup")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("each Codex verdict has its own words and command", () => {
    for (const [reason, words, command] of [
      ["codex-missing", "Codex is not installed on your host. Install it there, then sign in with ChatGPT:", "codex login"],
      ["codex-other-login", "Codex on your host is not signed in with ChatGPT. Run this there and pick ChatGPT:", "codex login"],
      ["codex-unknown", "Collie could not check the Codex sign-in on your host. To see why, run this there:", "codex login status"],
    ] as const) {
      const { unmount } = render(
        <SpeechCards {...props({ host: { ...HOST_NONE, switchable: { ...HOST_NONE.switchable, codex: { ok: false, reason } } } })} />,
      );
      expect(screen.getByText(words)).toBeInTheDocument();
      expect(screen.getByText(command)).toBeInTheDocument();
      unmount();
    }
  });

  it("Whistle on: it is chosen, and a tap on another choice reports it; a tap on the chosen one does nothing", async () => {
    const onChooseProvider = vi.fn();
    render(<SpeechCards {...props({ host: HOST_WHISTLE_ON, onChooseProvider })} />);
    expect(detail("Provider")).toHaveTextContent("Whistle");
    expect(detail("Status")).toHaveTextContent("Working");
    const whistle = within(group()).getByRole("radio", { name: /^Whistle/ });
    expect(whistle).toHaveAttribute("aria-checked", "true");
    await userEvent.click(whistle);
    expect(onChooseProvider).not.toHaveBeenCalled();
    await userEvent.click(within(group()).getByRole("radio", { name: /^Off/ }));
    expect(onChooseProvider).toHaveBeenCalledWith("off");
    await userEvent.click(within(group()).getByRole("radio", { name: /^Codex/ }));
    expect(onChooseProvider).toHaveBeenCalledWith("codex");
  });

  it("Codex on: the identity is named, honest or the codex-cli fallback, in words", () => {
    const { rerender } = render(<SpeechCards {...props({ host: HOST_CODEX_ON })} />);
    expect(detail("Provider")).toHaveTextContent("Codex (ChatGPT sign-in)");
    expect(detail("Identity")).toHaveTextContent("honest Collie names itself to the endpoint.");
    rerender(<SpeechCards {...props({ host: { ...HOST_CODEX_ON, identity: "codex-cli" } })} />);
    expect(detail("Identity")).toHaveTextContent("codex-cli Collie wears the Codex CLI's headers");
    expect(within(group()).getByRole("radio", { name: /^Codex/ })).toHaveAttribute("aria-checked", "true");
  });

  it("an unavailable provider shows the host's own reason", () => {
    render(<SpeechCards {...props({ host: { ...HOST_CODEX_ON, available: false, reason: "Codex is not signed in — run `codex login`" } })} />);
    expect(detail("Status")).toHaveTextContent("Codex is not signed in — run `codex login`");
  });

  it("a provider set up in a terminal is shown, not offered: the commands that change it, no choice", () => {
    render(<SpeechCards {...props({ host: HOST_KEYED })} />);
    expect(detail("Provider")).toHaveTextContent("OpenAI-compatible endpoint");
    expect(screen.queryByRole("radiogroup", { name: "Host speech provider" })).toBeNull();
    expect(screen.getByText(/This provider was set up in a terminal on the host/)).toBeInTheDocument();
    expect(screen.getByText("collie stt setup")).toBeInTheDocument();
    expect(screen.getByText("collie stt off")).toBeInTheDocument();
  });

  it("a local command and the environment are shown the same way, with their own command", () => {
    const { unmount } = render(<SpeechCards {...props({ host: { ...HOST_KEYED, provider: "local-cli" } })} />);
    expect(detail("Provider")).toHaveTextContent("A command on the host");
    unmount();
    render(<SpeechCards {...props({ host: { ...HOST_WHISTLE_ON, configuredBy: "env", switchable: LOCKED("env") } })} />);
    expect(screen.queryByRole("radiogroup", { name: "Host speech provider" })).toBeNull();
    expect(screen.getByText(/The host's environment sets the speech provider/)).toBeInTheDocument();
    expect(screen.getByText("collie stt status")).toBeInTheDocument();
  });

  it("a read-only device sees the status only", () => {
    render(<SpeechCards {...props({ host: HOST_CODEX_ON, canWrite: false })} />);
    expect(detail("Provider")).toHaveTextContent("Codex (ChatGPT sign-in)");
    expect(screen.queryByRole("radiogroup", { name: "Host speech provider" })).toBeNull();
    expect(screen.queryByText("collie stt setup")).toBeNull();
    expect(screen.getByText("A device with write access can change this.")).toBeInTheDocument();
  });

  it("while a choice is in flight, no other choice can be tapped", () => {
    render(<SpeechCards {...props({ host: HOST_WHISTLE_ON, switching: "off" })} />);
    for (const radio of within(group()).getAllByRole("radio")) expect(radio).toBeDisabled();
  });

  it("the consent sheet: the CLI's words with the endpoint and the binary, then Cancel or I accept", async () => {
    const onAcceptConsent = vi.fn();
    const onCancelConsent = vi.fn();
    render(<SpeechCards {...props({ host: HOST_WHISTLE_ON, consentOpen: true, onAcceptConsent, onCancelConsent })} />);
    const sheet = screen.getByRole("dialog", { name: "Use Codex for speech?" });
    expect(within(sheet).getByText(/Recordings would be sent to https:\/\/chatgpt\.com\/backend-api\/transcribe\./)).toBeInTheDocument();
    expect(within(sheet).getByText(/That endpoint is PRIVATE and UNSUPPORTED\./)).toBeInTheDocument();
    expect(within(sheet).getByText(new RegExp(`YOUR sign-in at ${CODEX_BIN.replaceAll(".", "\\.")}\\.`))).toBeInTheDocument();
    expect(within(sheet).getByText(/That is impersonation, and accepting here is what permits it\./)).toBeInTheDocument();
    expect(within(sheet).getByText("Nothing has run yet. Nothing is written unless you accept.")).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(onCancelConsent).toHaveBeenCalledTimes(1);
    expect(onAcceptConsent).not.toHaveBeenCalled();
    await userEvent.click(within(sheet).getByRole("button", { name: "I accept" }));
    expect(onAcceptConsent).toHaveBeenCalledTimes(1);
  });

  it("the consent sheet while the host probes: both buttons wait; a refusal is written in the sheet", () => {
    const { rerender } = render(<SpeechCards {...props({ host: HOST_WHISTLE_ON, consentOpen: true, switching: "codex" })} />);
    const sheet = screen.getByRole("dialog", { name: "Use Codex for speech?" });
    expect(within(sheet).getByRole("button", { name: "I accept" })).toBeDisabled();
    expect(within(sheet).getByRole("button", { name: "Cancel" })).toBeDisabled();
    rerender(<SpeechCards {...props({ host: HOST_WHISTLE_ON, consentOpen: true, consentError: "Codex is not signed in on your host. Run codex login there." })} />);
    expect(within(screen.getByRole("dialog")).getByText("Codex is not signed in on your host. Run codex login there.")).toBeInTheDocument();
  });
});

describe("SpeechCards, the phone step", () => {
  it("is not drawn before the host has a model or the phone a copy", () => {
    render(<SpeechCards {...props({ whistle: ABSENT })} />);
    expect(screen.queryByRole("heading", { name: "On this phone" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Set up on this phone/ })).toBeNull();
  });

  it("once the host is ready: a primary button with the size and one line, and a tap on it", async () => {
    const onPhoneDownload = vi.fn();
    render(<SpeechCards {...props({ whistle: READY, onPhoneDownload })} />);
    expect(screen.getByText("Copies the model from your host to this phone. Your recordings then stay on this phone.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Set up on this phone (16.9 MB)" }));
    expect(onPhoneDownload).toHaveBeenCalledTimes(1);
  });

  it("where this browser cannot run the engine: the reason stands in place of the button, and is said once on the page", () => {
    render(<SpeechCards {...props({ whistle: READY, block: "insecure" })} />);
    expect(screen.queryByRole("button", { name: /Set up on this phone/ })).toBeNull();
    const phone = screen.getByRole("region", { name: "On this phone" });
    expect(within(phone).getByText("This phone needs a secure connection (HTTPS) to run speech.")).toBeInTheDocument();
    expect(screen.getAllByText("This phone needs a secure connection (HTTPS) to run speech.")).toHaveLength(1);
  });

  it("copying: a bar in place of the button", () => {
    render(<SpeechCards {...props({ whistle: READY, copy: { received: BYTES / 4, total: BYTES } })} />);
    expect(screen.getByText("Copying to this phone")).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar").some((b) => b.getAttribute("aria-valuenow") === "25")).toBe(true);
    expect(screen.queryByRole("button", { name: /Set up on this phone/ })).toBeNull();
  });

  it("with a copy: says it is set up, names the version, says what the browser promised, and removes", async () => {
    const onPhoneRemove = vi.fn();
    const { rerender } = render(<SpeechCards {...props({ whistle: READY, local: COPY, persisted: true, onPhoneRemove })} />);
    const phone = screen.getByRole("region", { name: "On this phone" });
    expect(within(phone).getByText("Set up on this phone")).toBeInTheDocument();
    const version = within(phone).getByRole("link", { name: "Version ca52876 on Hugging Face" });
    expect(version).toHaveAttribute("href", `https://huggingface.co/Cactus-Compute/whistle/tree/${REVISION}`);
    expect(within(phone).getByText("Kept. This browser will not clear it to free space.")).toBeInTheDocument();
    await userEvent.click(within(phone).getByRole("button", { name: "Remove from this phone" }));
    expect(onPhoneRemove).toHaveBeenCalledTimes(1);
    rerender(<SpeechCards {...props({ whistle: READY, local: COPY, persisted: false })} />);
    expect(screen.getByText("This browser may clear it when space runs low.")).toBeInTheDocument();
  });

  it("a copy stored before revisions were recorded shows the hash prefix, not a link", () => {
    render(<SpeechCards {...props({ whistle: READY, local: { sha256: SHA, bytes: BYTES } })} />);
    const phone = screen.getByRole("region", { name: "On this phone" });
    expect(within(phone).getByText("Version").nextElementSibling).toHaveTextContent("b6e02f0");
    expect(within(phone).queryByRole("link")).toBeNull();
  });

  it("a newer model on the host: says so and offers Update; the same hash says nothing", async () => {
    const onPhoneDownload = vi.fn();
    const stale = { sha256: "a".repeat(64), bytes: BYTES, revision: "1f0e2d3c4b5a69788796a5b4c3d2e1f001122334" };
    const { rerender } = render(<SpeechCards {...props({ whistle: READY, local: stale, onPhoneDownload })} />);
    expect(screen.getByText("A newer model is on your host.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Version 1f0e2d3 on Hugging Face" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(onPhoneDownload).toHaveBeenCalledTimes(1);
    rerender(<SpeechCards {...props({ whistle: READY, local: COPY })} />);
    expect(screen.queryByText("A newer model is on your host.")).toBeNull();
  });

  it("Update is off while this browser cannot run the engine", () => {
    render(<SpeechCards {...props({ whistle: READY, local: { sha256: "a".repeat(64), bytes: BYTES }, block: "wasm-csp" })} />);
    expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
  });

  it("keeps the phone's copy visible when the host has none or no Whistle at all", () => {
    const { rerender } = render(<SpeechCards {...props({ whistle: ABSENT, local: COPY })} />);
    expect(screen.getByText("Set up on this phone")).toBeInTheDocument();
    rerender(<SpeechCards {...props({ whistle: null, local: COPY })} />);
    expect(screen.getByText("Set up on this phone")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "On your host" })).toBeNull();
  });

  it("shows a failed copy in words", () => {
    render(<SpeechCards {...props({ whistle: READY, phoneError: "The model did not match, so nothing was kept." })} />);
    expect(screen.getByText("The model did not match, so nothing was kept.")).toBeInTheDocument();
  });
});

describe("SpeechCards, the engine choice", () => {
  const group = () => screen.getByRole("radiogroup", { name: "Speech engine" });

  it("offers This phone and Host, and reports the choice", async () => {
    const onEngine = vi.fn();
    render(<SpeechCards {...props({ whistle: READY, hostStt: HOST_WHISTLE, local: COPY, onEngine })} />);
    expect(within(group()).getByRole("radio", { name: "Host" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(group()).getByRole("radio", { name: "This phone" }));
    expect(onEngine).toHaveBeenCalledWith("phone");
  });

  it("names what the host uses when it runs Whistle", () => {
    render(<SpeechCards {...props({ whistle: { ...READY, hostEngine: true }, hostStt: HOST_WHISTLE })} />);
    expect(screen.getByText("Your host uses Whistle.")).toBeInTheDocument();
  });

  it("names the host's provider when it is another one", () => {
    render(<SpeechCards {...props({ whistle: READY, hostStt: { provider: "openai-compatible", available: true } })} />);
    expect(screen.getByText("Your host uses openai-compatible.")).toBeInTheDocument();
    expect(within(group()).getByRole("radio", { name: "Host" })).toBeEnabled();
  });

  it("disables Host, with the reason, when the host has no speech provider", () => {
    render(<SpeechCards {...props({ whistle: READY, hostStt: null })} />);
    expect(within(group()).getByRole("radio", { name: "Host" })).toBeDisabled();
    expect(
      screen.getByText("Your host has no speech provider. Choose one under Host speech provider above, or run collie stt setup."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Your host uses/)).toBeNull();
  });

  it("disables Host when the provider exists but cannot serve", () => {
    render(<SpeechCards {...props({ whistle: READY, hostStt: { provider: "whistle", available: false, reason: "engine files missing" } })} />);
    expect(within(group()).getByRole("radio", { name: "Host" })).toBeDisabled();
  });

  it("disables This phone until it is set up, and says so once", () => {
    render(<SpeechCards {...props({ whistle: READY, hostStt: HOST_WHISTLE })} />);
    expect(within(group()).getByRole("radio", { name: "This phone" })).toBeDisabled();
    expect(screen.getAllByText("Set up Whistle on this phone first.")).toHaveLength(1);
  });

  it("sends the person to the host first when neither has the model", () => {
    render(<SpeechCards {...props({ whistle: ABSENT, block: "host-not-ready" })} />);
    expect(within(group()).getByRole("radio", { name: "This phone" })).toBeDisabled();
    expect(screen.getByText("Download Whistle to your host first, then set it up on this phone.")).toBeInTheDocument();
  });

  it("with a copy but a browser that blocks the engine: This phone is off, the reason is under the choice, and Host shows", () => {
    render(<SpeechCards {...props({ whistle: READY, hostStt: HOST_WHISTLE, engine: "phone", local: COPY, block: "wasm-csp" })} />);
    expect(within(group()).getByRole("radio", { name: "This phone" })).toBeDisabled();
    expect(within(group()).getByRole("radio", { name: "Host" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getAllByText("This browser blocked the speech engine.")).toHaveLength(1);
  });

  it("shows This phone selected when it is chosen and can run", () => {
    render(<SpeechCards {...props({ whistle: READY, hostStt: HOST_WHISTLE, engine: "phone", local: COPY })} />);
    expect(within(group()).getByRole("radio", { name: "This phone" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("SpeechCards does not move on a state", () => {
  it("keeps every button at 44px on every host state", () => {
    for (const whistle of [ABSENT, { ...ABSENT, state: "failed" as const }, READY]) {
      const { unmount } = render(<SpeechCards {...props({ whistle })} />);
      for (const button of screen.getAllByRole("button")) expect(button.className).toMatch(/\bh-11\b|\bmin-h-11\b/);
      unmount();
    }
  });
});

// ── The controller ────────────────────────────────────────────────────────────────────────────────

function renderControl() {
  const router = createMemoryRouter([{ path: "/", element: <SpeechControl /> }]);
  return render(<RouterProvider router={router} />);
}

function config(whistle: WhistleStatus | undefined, stt?: SttCapability) {
  return http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", whistle, stt }));
}

/** jsdom is neither a secure context nor a browser with Workers and Cache Storage; a phone is. */
function stubPhoneBrowser() {
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("Worker", vi.fn());
  vi.stubGlobal("caches", {});
}

/** The host's provider, as GET /api/stt/host answers it. */
function hostStatus(body: SttHostStatus | null) {
  return http.get("/api/stt/host", () => (body === null ? new HttpResponse("not found", { status: 404 }) : HttpResponse.json(body)));
}

beforeEach(() => {
  server.use(hostStatus(null));
  stubPhoneBrowser();
  __resetOperatorCommands();
  __resetSttEngine();
  localStorage.clear();
  vi.mocked(sttModel.storedModel).mockResolvedValue(null);
  vi.mocked(sttModel.downloadModel).mockReset();
});

describe("SpeechControl", () => {
  it("draws the Whistle block from /api/config, and nothing on a host without the field", async () => {
    server.use(config(ABSENT));
    renderControl();
    expect(await screen.findByRole("button", { name: "Download to host (16.9 MB)" })).toBeInTheDocument();
    cleanup();

    __resetOperatorCommands();
    server.use(config(undefined));
    const { container } = renderControl();
    await new Promise((r) => setTimeout(r, 50));
    expect(container).toBeEmptyDOMElement();
  });

  it("taps the setup: POSTs, shows the download, then follows the host's progress once a second", async () => {
    let polls = 0;
    server.use(
      config(ABSENT),
      http.post("/api/stt/whistle", () => HttpResponse.json({ ...ABSENT, state: "downloading", received: 0 }, { status: 202 })),
      http.get("/api/stt/whistle", () => {
        polls += 1;
        return HttpResponse.json(polls < 2 ? { ...ABSENT, state: "downloading", received: BYTES / 2 } : READY);
      }),
    );
    renderControl();
    await userEvent.click(await screen.findByRole("button", { name: "Download to host (16.9 MB)" }));
    expect(await screen.findByRole("progressbar", { name: "Model download progress" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50"), { timeout: 3000 });
    expect(await screen.findByText("sha256 b6e02f04…", {}, { timeout: 4000 })).toBeInTheDocument();
    const stopped = polls;
    await new Promise((r) => setTimeout(r, 1300));
    expect(polls).toBe(stopped); // ready: the polling ended with the download
  }, 12000);

  it("does not poll while the host holds a finished model", async () => {
    let polls = 0;
    server.use(
      config(READY),
      http.get("/api/stt/whistle", () => {
        polls += 1;
        return HttpResponse.json(READY);
      }),
    );
    renderControl();
    await screen.findByText("sha256 b6e02f04…");
    await new Promise((r) => setTimeout(r, 1300));
    expect(polls).toBe(0);
  });

  it("reads the host's provider and switches to Whistle with one PUT, then shows the host's answer", async () => {
    const bodies: unknown[] = [];
    server.use(
      config(READY),
      hostStatus({ ...HOST_NONE, switchable: { ...HOST_NONE.switchable, whistle: { ok: true } } }),
      http.put("/api/stt/host", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(HOST_WHISTLE_ON);
      }),
    );
    renderControl();
    const group = await screen.findByRole("radiogroup", { name: "Host speech provider" });
    await userEvent.click(within(group).getByRole("radio", { name: /^Whistle/ }));
    expect(bodies).toEqual([{ provider: "whistle" }]);
    await waitFor(() => expect(within(group).getByRole("radio", { name: /^Whistle/ })).toHaveAttribute("aria-checked", "true"));
  });

  it("says a refused switch in words, in the operator's language", async () => {
    server.use(
      config(READY),
      hostStatus(HOST_WHISTLE_ON),
      http.put("/api/stt/host", () =>
        HttpResponse.json({ error: "changed", code: "stt.host_changed" }, { status: 409 }),
      ),
    );
    renderControl();
    const group = await screen.findByRole("radiogroup", { name: "Host speech provider" });
    await userEvent.click(within(group).getByRole("radio", { name: /^Off/ }));
    expect(await screen.findByText("The speech settings on your host changed meanwhile. Nothing was changed.")).toBeInTheDocument();
  });

  it("Codex: the tap opens the consent and sends nothing; I accept sends the consent's id", async () => {
    const bodies: unknown[] = [];
    server.use(
      config(READY),
      hostStatus(HOST_WHISTLE_ON),
      http.put("/api/stt/host", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(HOST_CODEX_ON);
      }),
    );
    renderControl();
    const group = await screen.findByRole("radiogroup", { name: "Host speech provider" });
    await userEvent.click(within(group).getByRole("radio", { name: /^Codex/ }));
    const sheet = await screen.findByRole("dialog", { name: "Use Codex for speech?" });
    expect(bodies).toEqual([]);
    await userEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(bodies).toEqual([]);

    await userEvent.click(within(group).getByRole("radio", { name: /^Codex/ }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "I accept" }));
    await waitFor(() => expect(bodies).toEqual([{ provider: "codex", consent: CODEX_CONSENT_ID }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("Collie names itself to the endpoint.", { exact: false })).toBeInTheDocument();
  });

  it("Codex refused: the reason is written in the open sheet", async () => {
    server.use(
      config(READY),
      hostStatus(HOST_WHISTLE_ON),
      http.put("/api/stt/host", () =>
        HttpResponse.json({ error: "probe", code: "stt.codex_probe_failed", detail: { reason: "both identities were refused" } }, { status: 502 }),
      ),
    );
    renderControl();
    const group = await screen.findByRole("radiogroup", { name: "Host speech provider" });
    await userEvent.click(within(group).getByRole("radio", { name: /^Codex/ }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "I accept" }));
    const sheet = screen.getByRole("dialog");
    expect(await within(sheet).findByText("The Codex endpoint did not accept Collie: both identities were refused")).toBeInTheDocument();
  });

  it("removes the model from the host after the second tap", async () => {
    let deleted = 0;
    server.use(
      // The config is read again after a removal, and must then tell the truth.
      http.get("/api/config", () =>
        HttpResponse.json({ push: false, vapidPublicKey: "", whistle: deleted === 0 ? READY : ABSENT }),
      ),
      http.delete("/api/stt/whistle", () => {
        deleted += 1;
        return HttpResponse.json(ABSENT);
      }),
    );
    renderControl();
    await userEvent.click(await screen.findByRole("button", { name: "Remove from host" }));
    expect(deleted).toBe(0);
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(deleted).toBe(1));
    expect(await screen.findByRole("button", { name: "Download to host (16.9 MB)" })).toBeInTheDocument();
  });

  it("copies to the phone with progress, then shows the copy", async () => {
    server.use(config(READY));
    vi.mocked(sttModel.downloadModel).mockImplementation(async (_status, onProgress) => {
      onProgress(BYTES / 2, BYTES);
      await new Promise((r) => setTimeout(r, 30));
      vi.mocked(sttModel.storedModel).mockResolvedValue({ sha256: SHA, bytes: BYTES, revision: REVISION });
      return { sha256: SHA, bytes: BYTES, revision: REVISION, persisted: true };
    });
    renderControl();
    await userEvent.click(await screen.findByRole("button", { name: "Set up on this phone (16.9 MB)" }));
    expect(sttModel.downloadModel).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Copying to this phone")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Copying to this phone")).toBeNull());
    // The copy is on the phone now: the step says so and names the version it holds.
    expect(await screen.findByRole("link", { name: "Version ca52876 on Hugging Face" })).toBeInTheDocument();
  });

  it("says a busy host in words and leaves the download button to tap again", async () => {
    server.use(config(READY));
    vi.mocked(sttModel.downloadModel).mockRejectedValue(new sttModel.SttModelError("busy"));
    renderControl();
    await userEvent.click(await screen.findByRole("button", { name: "Set up on this phone (16.9 MB)" }));
    expect(await screen.findByText("The host is busy copying the model to other phones. Try again shortly.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set up on this phone (16.9 MB)" })).toBeEnabled();
  });

  it("says a failed copy in words", async () => {
    server.use(config(READY));
    vi.mocked(sttModel.downloadModel).mockRejectedValue(new sttModel.SttModelError("hash-mismatch"));
    renderControl();
    await userEvent.click(await screen.findByRole("button", { name: "Set up on this phone (16.9 MB)" }));
    expect(await screen.findByText("The model did not match, so nothing was kept.")).toBeInTheDocument();
  });

  it("reads the host's speech provider from the config, and names it under the choice", async () => {
    server.use(config({ ...READY, hostEngine: true }, { provider: "whistle", available: true }));
    renderControl();
    expect(await screen.findByText("Your host uses Whistle.")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Host" })).toBeEnabled();
    cleanup();

    __resetOperatorCommands();
    server.use(config(READY));
    renderControl();
    expect(
      await screen.findByText("Your host has no speech provider. Choose one under Host speech provider above, or run collie stt setup."),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Host" })).toBeDisabled();
  });

  it("stores the engine choice on the device", async () => {
    server.use(config(READY));
    renderControl();
    await screen.findByText("sha256 b6e02f04…");
    // jsdom has no WebAssembly Worker or Cache Storage, so This phone is off here; the choice itself
    // is the preference store's, covered in stt.test.ts. The row must at least not claim it is on.
    expect(screen.getByRole("radio", { name: "Host" })).toHaveAttribute("aria-checked", "true");
    expect(sttEnginePreference()).toBe("host");
  });
});
