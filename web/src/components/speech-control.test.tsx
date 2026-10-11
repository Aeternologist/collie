import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetOperatorCommands } from "@/lib/operator-config";
import { __resetSttEngine, sttEnginePreference } from "@/lib/stt";
import * as sttModel from "@/lib/stt-model";
import type { WhistleStatus } from "@/lib/types";
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
const BYTES = 16_919_407;

const ABSENT: WhistleStatus = { state: "absent", bytes: BYTES, hostEngine: false, hostTaken: false };
const READY: WhistleStatus = { ...ABSENT, state: "ready", sha256: SHA };

function props(over: Partial<SpeechCardsProps> = {}): SpeechCardsProps {
  return {
    whistle: ABSENT,
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
    onHostEngine: vi.fn(),
    onPhoneDownload: vi.fn(),
    onPhoneRemove: vi.fn(),
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SpeechCards, the engine choice", () => {
  it("draws nothing where the host offers no Whistle and the phone holds no copy", () => {
    const { container } = render(<SpeechCards {...props({ whistle: null })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers Host and This phone, and reports the choice", async () => {
    const onEngine = vi.fn();
    render(<SpeechCards {...props({ whistle: READY, onEngine })} />);
    const group = screen.getByRole("radiogroup", { name: "Speech engine" });
    expect(within(group).getByRole("radio", { name: "Host" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(group).getByRole("radio", { name: "This phone" }));
    expect(onEngine).toHaveBeenCalledWith("phone");
  });

  it("disables This phone with the first reason, and still shows Host when the stored choice cannot run", () => {
    render(<SpeechCards {...props({ whistle: READY, engine: "phone", block: "wasm-csp" })} />);
    expect(screen.getByRole("radio", { name: "This phone" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Host" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getAllByText("This browser blocked the speech engine.").length).toBeGreaterThan(0);
  });

  it("says why when the host is not ready yet", () => {
    render(<SpeechCards {...props({ block: "host-not-ready" })} />);
    expect(screen.getByRole("radio", { name: "This phone" })).toBeDisabled();
    expect(screen.getByText("Set up Whistle first.")).toBeInTheDocument();
  });

  it("asks for the phone's own copy when This phone is chosen and none is there", () => {
    render(<SpeechCards {...props({ whistle: READY, engine: "phone", local: null })} />);
    expect(screen.getByText("Download the Whistle model to this phone below to use it.")).toBeInTheDocument();
  });
});

describe("SpeechCards, the host's model", () => {
  it("absent: a write device sees the setup button with the size, and taps it", async () => {
    const onSetup = vi.fn();
    render(<SpeechCards {...props({ onSetup })} />);
    expect(screen.getByText(/Your host downloads the model once, from Hugging Face/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Set up Whistle (16.9 MB)" }));
    expect(onSetup).toHaveBeenCalledTimes(1);
  });

  it("absent: a read-only device sees the sentence and no button", () => {
    render(<SpeechCards {...props({ canWrite: false })} />);
    expect(screen.getByText("A device with write access can set this up.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Set up Whistle/ })).toBeNull();
  });

  it("downloading: a determinate bar from received over bytes", () => {
    render(<SpeechCards {...props({ whistle: { ...ABSENT, state: "downloading", received: Math.round(BYTES / 2) } })} />);
    const bar = screen.getByRole("progressbar", { name: "Model download progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("8.5 MB of 16.9 MB")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Set up Whistle/ })).toBeNull();
  });

  it("failed: the reason and Try again", async () => {
    const onSetup = vi.fn();
    render(<SpeechCards {...props({ whistle: { ...ABSENT, state: "failed", reason: "Hugging Face answered 503." }, onSetup })} />);
    expect(screen.getByText("The download failed.")).toBeInTheDocument();
    expect(screen.getByText("Hugging Face answered 503.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onSetup).toHaveBeenCalledTimes(1);
  });

  it("ready: the size, and Remove from host takes two taps", async () => {
    const onAskRemove = vi.fn();
    const { rerender } = render(<SpeechCards {...props({ whistle: READY, onAskRemove })} />);
    expect(screen.getByText("On your host, 16.9 MB")).toBeInTheDocument();
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

  it("ready: a read-only device sees the size but cannot remove or switch", () => {
    render(<SpeechCards {...props({ whistle: READY, canWrite: false })} />);
    expect(screen.getByText("On your host, 16.9 MB")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove from host" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Use on host" })).toBeDisabled();
  });

  it("ready: Use on host reflects the host and flips it", async () => {
    const onHostEngine = vi.fn();
    const { rerender } = render(<SpeechCards {...props({ whistle: READY, onHostEngine })} />);
    const toggle = screen.getByRole("switch", { name: "Use on host" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await userEvent.click(toggle);
    expect(onHostEngine).toHaveBeenCalledWith(true);
    rerender(<SpeechCards {...props({ whistle: { ...READY, hostEngine: true }, onHostEngine })} />);
    expect(screen.getByRole("switch", { name: "Use on host" })).toHaveAttribute("aria-checked", "true");
  });

  it("ready: Use on host is disabled with the reason when another provider holds the host", () => {
    render(<SpeechCards {...props({ whistle: { ...READY, hostTaken: true } })} />);
    const toggle = screen.getByRole("switch", { name: "Use on host" });
    expect(toggle).toBeDisabled();
    expect(screen.getByText("Another speech provider is set up on the host.")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-describedby");
  });

  it("ready: the switch stays usable to turn Whistle OFF even though a provider is configured", () => {
    render(<SpeechCards {...props({ whistle: { ...READY, hostTaken: true, hostEngine: true } })} />);
    expect(screen.getByRole("switch", { name: "Use on host" })).not.toBeDisabled();
  });

  it("shows a failed host action in words", () => {
    render(<SpeechCards {...props({ whistle: READY, hostError: "Another speech provider is set up on the host." })} />);
    expect(screen.getAllByText("Another speech provider is set up on the host.").length).toBeGreaterThan(0);
  });
});

describe("SpeechCards, this phone's copy", () => {
  it("offers the download once the host is ready", async () => {
    const onPhoneDownload = vi.fn();
    render(<SpeechCards {...props({ whistle: READY, onPhoneDownload })} />);
    await userEvent.click(screen.getByRole("button", { name: "Download to this phone" }));
    expect(onPhoneDownload).toHaveBeenCalledTimes(1);
  });

  it("offers nothing for the phone before the host has a model or the phone a copy", () => {
    render(<SpeechCards {...props({ whistle: ABSENT })} />);
    expect(screen.queryByRole("button", { name: "Download to this phone" })).toBeNull();
  });

  it("disables the download, and says why once, where this browser cannot run the engine", () => {
    render(<SpeechCards {...props({ whistle: READY, block: "insecure" })} />);
    expect(screen.getByRole("button", { name: "Download to this phone" })).toBeDisabled();
    expect(screen.getAllByText("This phone needs a secure connection (HTTPS) to run speech.").length).toBe(1);
  });

  it("copying: a bar in place of the button", () => {
    render(<SpeechCards {...props({ whistle: READY, copy: { received: BYTES / 4, total: BYTES } })} />);
    expect(screen.getByText("Copying to this phone")).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar").some((b) => b.getAttribute("aria-valuenow") === "25")).toBe(true);
    expect(screen.queryByRole("button", { name: "Download to this phone" })).toBeNull();
  });

  it("on this phone: the size, Remove, and what the browser promised", async () => {
    const onPhoneRemove = vi.fn();
    const local = { sha256: SHA, bytes: BYTES };
    const { rerender } = render(<SpeechCards {...props({ whistle: READY, local, persisted: true, onPhoneRemove })} />);
    expect(screen.getByText("On this phone, 16.9 MB")).toBeInTheDocument();
    expect(screen.getByText("Kept. This browser will not clear it to free space.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove from this phone" }));
    expect(onPhoneRemove).toHaveBeenCalledTimes(1);
    rerender(<SpeechCards {...props({ whistle: READY, local, persisted: false })} />);
    expect(screen.getByText("This browser may clear it when space runs low.")).toBeInTheDocument();
  });

  it("a newer model on the host: says so and offers Download; the same hash says nothing", async () => {
    const onPhoneDownload = vi.fn();
    const stale = { sha256: "a".repeat(64), bytes: BYTES };
    const { rerender } = render(<SpeechCards {...props({ whistle: READY, local: stale, onPhoneDownload })} />);
    expect(screen.getByText("A newer model is on the host.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(onPhoneDownload).toHaveBeenCalledTimes(1);
    rerender(<SpeechCards {...props({ whistle: READY, local: { sha256: SHA, bytes: BYTES } })} />);
    expect(screen.queryByText("A newer model is on the host.")).toBeNull();
  });

  it("keeps the phone's copy visible when the host has none or no Whistle at all", () => {
    const local = { sha256: SHA, bytes: BYTES };
    const { rerender } = render(<SpeechCards {...props({ whistle: ABSENT, local })} />);
    expect(screen.getByText("On this phone, 16.9 MB")).toBeInTheDocument();
    rerender(<SpeechCards {...props({ whistle: null, local })} />);
    expect(screen.getByText("On this phone, 16.9 MB")).toBeInTheDocument();
  });

  it("shows a failed copy in words", () => {
    render(<SpeechCards {...props({ whistle: READY, phoneError: "The model did not match, so nothing was kept." })} />);
    expect(screen.getByText("The model did not match, so nothing was kept.")).toBeInTheDocument();
  });
});

describe("SpeechCards does not move on a state", () => {
  it("keeps the same engine card and the same host-row buttons at 44px on every host state", () => {
    for (const whistle of [ABSENT, { ...ABSENT, state: "failed" as const }, READY]) {
      const { unmount } = render(<SpeechCards {...props({ whistle })} />);
      for (const button of screen.getAllByRole("button")) expect(button.className).toMatch(/\bh-11\b/);
      unmount();
    }
  });
});

// ── The controller ────────────────────────────────────────────────────────────────────────────────

function renderControl() {
  const router = createMemoryRouter([{ path: "/", element: <SpeechControl /> }]);
  return render(<RouterProvider router={router} />);
}

function config(whistle: WhistleStatus | undefined) {
  return http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", whistle }));
}

/** jsdom is neither a secure context nor a browser with Workers and Cache Storage; a phone is. */
function stubPhoneBrowser() {
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("Worker", vi.fn());
  vi.stubGlobal("caches", {});
}

beforeEach(() => {
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
    expect(await screen.findByRole("button", { name: "Set up Whistle (16.9 MB)" })).toBeInTheDocument();
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
    await userEvent.click(await screen.findByRole("button", { name: "Set up Whistle (16.9 MB)" }));
    expect(await screen.findByRole("progressbar", { name: "Model download progress" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50"), { timeout: 3000 });
    expect(await screen.findByText("On your host, 16.9 MB", {}, { timeout: 4000 })).toBeInTheDocument();
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
    await screen.findByText("On your host, 16.9 MB");
    await new Promise((r) => setTimeout(r, 1300));
    expect(polls).toBe(0);
  });

  it("turns the host engine on with PUT, and says a refusal in words", async () => {
    const bodies: unknown[] = [];
    server.use(
      config(READY),
      http.put("/api/stt/whistle/host", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ error: "taken", code: "stt.whistle_provider_taken" }, { status: 409 });
      }),
    );
    renderControl();
    await userEvent.click(await screen.findByRole("switch", { name: "Use on host" }));
    expect(bodies).toEqual([{ on: true }]);
    expect(await screen.findByText("Another speech provider is set up on the host.")).toBeInTheDocument();
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
    expect(await screen.findByRole("button", { name: "Set up Whistle (16.9 MB)" })).toBeInTheDocument();
  });

  it("copies to the phone with progress, then shows the copy", async () => {
    server.use(config(READY));
    vi.mocked(sttModel.downloadModel).mockImplementation(async (_status, onProgress) => {
      onProgress(BYTES / 2, BYTES);
      await new Promise((r) => setTimeout(r, 30));
      vi.mocked(sttModel.storedModel).mockResolvedValue({ sha256: SHA, bytes: BYTES });
      return { sha256: SHA, bytes: BYTES, persisted: true };
    });
    renderControl();
    await userEvent.click(await screen.findByRole("button", { name: "Download to this phone" }));
    expect(sttModel.downloadModel).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Copying to this phone")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Copying to this phone")).toBeNull());
  });

  it("says a busy host in words and leaves the download button to tap again", async () => {
    server.use(config(READY));
    vi.mocked(sttModel.downloadModel).mockRejectedValue(new sttModel.SttModelError("busy"));
    renderControl();
    await userEvent.click(await screen.findByRole("button", { name: "Download to this phone" }));
    expect(await screen.findByText("The host is busy copying the model to other phones. Try again shortly.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download to this phone" })).toBeEnabled();
  });

  it("says a failed copy in words", async () => {
    server.use(config(READY));
    vi.mocked(sttModel.downloadModel).mockRejectedValue(new sttModel.SttModelError("hash-mismatch"));
    renderControl();
    await userEvent.click(await screen.findByRole("button", { name: "Download to this phone" }));
    expect(await screen.findByText("The model did not match, so nothing was kept.")).toBeInTheDocument();
  });

  it("stores the engine choice on the device", async () => {
    server.use(config(READY));
    renderControl();
    await screen.findByText("On your host, 16.9 MB");
    // jsdom has no WebAssembly Worker or Cache Storage, so This phone is off here; the choice itself
    // is the preference store's, covered in stt.test.ts. The row must at least not claim it is on.
    expect(screen.getByRole("radio", { name: "Host" })).toHaveAttribute("aria-checked", "true");
    expect(sttEnginePreference()).toBe("host");
  });
});
