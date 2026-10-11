import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetOperatorCommands } from "@/lib/operator-config";
import { __resetHandsFree, __resetSttEngine } from "@/lib/stt";
import * as sttModel from "@/lib/stt-model";
import type { SttCapability, WhistleStatus } from "@/lib/types";
import { server } from "@/test/setup";
import { withHeaderHost } from "@/test/header-host";
import { SettingsDeviceRoute, SettingsVoiceRoute } from "./settings-sections";

// Settings → Voice: where dictation lives, since the Speech cards and the hands-free switch left
// Device. These cases pin the move (they render on Voice and not on Device) and the one thing the
// page owes when its row is always offered: an answer when it has nothing to show.

vi.mock("@/lib/stt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stt")>()),
  runSttProbe: vi.fn(async () => {}),
}));

vi.mock("@/lib/stt-model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stt-model")>()),
  storedModel: vi.fn(async () => null),
  modelPersisted: vi.fn(async () => false),
}));

const BYTES = 16_919_407;
const WHISTLE: WhistleStatus = { state: "absent", bytes: BYTES, hostEngine: false, hostTaken: false };
const STT: SttCapability = { provider: "whistle", available: true };

function renderRoute(path: "voice" | "device") {
  const router = createMemoryRouter(
    [
      {
        path: `/settings/${path}`,
        element: withHeaderHost(path === "voice" ? <SettingsVoiceRoute /> : <SettingsDeviceRoute />),
      },
      { path: "/settings", element: <div data-testid="settings" /> },
    ],
    { initialEntries: [`/settings/${path}`] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

function config(body: { whistle?: WhistleStatus; stt?: SttCapability }) {
  return http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", ...body }));
}

/** jsdom can neither record nor run a worker; a phone can. */
function stubPhoneBrowser() {
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("Worker", vi.fn());
  vi.stubGlobal("caches", {});
  vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
  vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: vi.fn() } });
}

beforeEach(() => {
  stubPhoneBrowser();
  __resetOperatorCommands();
  __resetSttEngine();
  __resetHandsFree();
  localStorage.clear();
  vi.mocked(sttModel.storedModel).mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Settings → Voice", () => {
  it("is titled Voice and carries the Whistle card, the Speech engine card and hands-free, in that order", async () => {
    server.use(config({ whistle: WHISTLE, stt: STT }));
    renderRoute("voice");
    expect(await screen.findByRole("heading", { name: "Voice" })).toBeInTheDocument();
    const whistle = await screen.findByText(/Whistle is a speech model by/);
    const engine = await screen.findByRole("radiogroup", { name: "Speech engine" });
    const handsFree = await screen.findByRole("switch", { name: "Hands-free voice: send transcript immediately" });
    const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(whistle, engine)).toBe(true);
    expect(follows(engine, handsFree)).toBe(true);
  });

  it("names the host's provider under the engine choice, from the config", async () => {
    server.use(config({ whistle: { ...WHISTLE, state: "ready", hostEngine: true }, stt: STT }));
    renderRoute("voice");
    expect(await screen.findByText("Your host uses Whistle.")).toBeInTheDocument();
  });

  it("goes back to the Settings index", async () => {
    server.use(config({ whistle: WHISTLE, stt: STT }));
    const { router } = renderRoute("voice");
    await userEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(router.state.location.pathname).toBe("/settings");
  });

  it("says why it is empty on a host that offers nothing, once the config has been read", async () => {
    server.use(config({}));
    renderRoute("voice");
    expect(await screen.findByText(/Nothing to set up here yet\./)).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("says nothing about being empty before the config has been read", async () => {
    server.use(http.get("/api/config", async () => new Promise<never>(() => {})));
    renderRoute("voice");
    await screen.findByRole("heading", { name: "Voice" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/Nothing to set up here yet\./)).toBeNull();
  });

  it("is not empty when only hands-free has something to show", async () => {
    server.use(config({ stt: { provider: "openai-compatible", available: true } }));
    renderRoute("voice");
    expect(await screen.findByRole("switch", { name: "Hands-free voice: send transcript immediately" })).toBeInTheDocument();
    expect(screen.queryByText(/Nothing to set up here yet\./)).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("is not empty when only the phone holds a copy", async () => {
    server.use(config({}));
    vi.mocked(sttModel.storedModel).mockResolvedValue({ sha256: "b".repeat(64), bytes: BYTES });
    renderRoute("voice");
    expect(await screen.findByRole("radiogroup", { name: "Speech engine" })).toBeInTheDocument();
    expect(screen.queryByText(/Nothing to set up here yet\./)).toBeNull();
  });
});

describe("Settings → Device after the move", () => {
  it("no longer carries the Speech cards or the hands-free switch", async () => {
    server.use(config({ whistle: { ...WHISTLE, state: "ready" }, stt: STT }));
    renderRoute("device");
    await screen.findByRole("heading", { name: "Device" });
    // The page has settled once its own always-present card is there; then nothing speech-shaped appears.
    await within(document.body).findByText("Zen mode");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/Whistle/)).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Speech engine" })).toBeNull();
    expect(screen.queryByRole("switch", { name: /Hands-free/ })).toBeNull();
  });
});
