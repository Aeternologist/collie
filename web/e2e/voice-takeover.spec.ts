import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";

// THE VOICE TAKEOVER, measured in a real engine (design 3.3). The requirement is zero layout shift:
// the takeover covers the whole composer block, from the mic's tap to the transcript, and nothing
// above it may move by a pixel. jsdom has no layout, so the rectangles are asserted here, in
// Chromium and in WebKit (`app-phone-webkit`).
//
// THE MICROPHONE IS A REAL WEB AUDIO GRAPH, NOT A MOCK OF OUR CODE. An init script replaces only
// `getUserMedia` with a stream made from an oscillator through a gain node, and the page's own
// MediaRecorder, AudioContext and AnalyserNode read it. The test sets the gain: 0 is a quiet room,
// 0.3 is a voice. So the level meter, the speech detector, the ring and the auto-finish run for real.
//
// Stubbed route handlers are blocked from being shadowed by the service worker, hence "block".

test.use({ serviceWorkers: "block" });

/** What the init script below puts on the page: the fake microphone's controls and the meter's contexts. */
interface FakeVoice {
  gain: GainNode | null;
  context: AudioContext | null;
  opened: number;
  metered: AudioContext[];
}
declare global {
  interface Window {
    __voice?: FakeVoice;
  }
}

const TRANSCRIPT = "hello from the microphone";

test.beforeEach(async ({ page }) => {
  await installApiStub(page);
  // Registered after the stub, so it wins: this bridge publishes a speech provider.
  await page.route("**/api/config", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        push: false,
        vapidPublicKey: "",
        stt: { provider: "openai-compatible", available: true },
      }),
    }),
  );
  await page.route("**/api/stt", async (route) => {
    // Slow enough to be measured while it is in flight.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, text: TRANSCRIPT }) });
  });
  await page.addInitScript(() => {
    const voice: FakeVoice = {
      gain: null,
      context: null,
      opened: 0,
      metered: [],
    };
    Object.defineProperty(window, "__voice", { value: voice });
    // Every AudioContext the PAGE makes (the level meter's) is recorded; the fake microphone below
    // uses the original constructor, so it is not among them.
    const Original = window.AudioContext;
    window.AudioContext = class extends Original {
      constructor(options?: AudioContextOptions) {
        super(options);
        voice.metered.push(this);
      }
    };
    // Playwright's Linux WebKit ships no MediaRecorder at all (a real iPhone has one), and without one
    // the composer draws no mic. A bare stand-in, only there when the engine has none: it makes a
    // small clip so the upload happens. The Web Audio graph under test stays the engine's own.
    if (!("MediaRecorder" in window)) {
      class StandInRecorder extends EventTarget {
        static isTypeSupported(type: string) {
          return type === "audio/mp4";
        }
        state = "inactive";
        mimeType = "audio/mp4";
        start() {
          this.state = "recording";
        }
        stop() {
          if (this.state === "inactive") return;
          this.state = "inactive";
          const event = new Event("dataavailable");
          Object.defineProperty(event, "data", { value: new Blob([new Uint8Array(2048)], { type: "audio/mp4" }) });
          this.dispatchEvent(event);
          this.dispatchEvent(new Event("stop"));
        }
      }
      Object.defineProperty(window, "MediaRecorder", { value: StandInRecorder, configurable: true });
    }
    // Redefined whole: WebKit hands back a fresh `mediaDevices` object per read, so assigning one
    // method onto it would be lost.
    const getUserMedia = async () => {
      const context = new Original();
      await context.resume();
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 220;
      const gain = context.createGain();
      gain.gain.value = 0;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      voice.gain = gain;
      voice.context = context;
      voice.opened += 1;
      return destination.stream;
    };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  });
});

/** The takeover's own live region (the page has others). */
const status = (page: Page) => page.getByRole("group", { name: en["composer.voice.regionAria"] }).getByRole("status");

/** Set the fake room: 0 is quiet, 0.3 is a voice. */
async function setLoudness(page: Page, level: number) {
  await page.evaluate((value) => {
    const gain = window.__voice?.gain;
    if (gain) gain.gain.value = value;
  }, level);
}

async function rects(page: Page) {
  return page.evaluate(() => {
    const block = document.querySelector('[data-slot="chrome-block"]')!;
    // Everything above the block: the column the block sits at the foot of, and the screen's scroll height.
    const above = block.parentElement!.parentElement!;
    return {
      block: block.getBoundingClientRect().toJSON(),
      above: above.getBoundingClientRect().toJSON(),
      scrollHeight: document.documentElement.scrollHeight,
    };
  });
}

test("the takeover opens, records, transcribes and closes without moving anything", async ({ page }) => {
  await page.goto("/pane/w1:p1");
  const mic = page.getByRole("button", { name: en["composer.mic.recordAria"] });
  await expect(mic).toBeVisible();
  const before = await rects(page);
  const micBox = (await mic.boundingBox())!;
  // The block is whatever the composer is: never a number written down here.
  expect(before.block.height).toBeGreaterThan(80);

  await mic.click();
  const region = page.getByRole("group", { name: en["composer.voice.regionAria"] });
  await expect(region).toBeVisible();

  // It fills the composer's own box exactly (the block less its 1px top rule).
  const regionBox = (await region.boundingBox())!;
  expect(Math.abs(regionBox.width - before.block.width)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(regionBox.height - (before.block.height - 1))).toBeLessThanOrEqual(1.5);
  expect(Math.abs(regionBox.y - before.block.top)).toBeLessThanOrEqual(1.5);
  expect(await rects(page)).toEqual(before);

  // OK stands on the mic's spot: the same centre, the same size.
  const ok = page.getByRole("button", { name: en["composer.voice.okAria"] });
  await expect(ok).toBeEnabled();
  const okBox = (await ok.boundingBox())!;
  expect(Math.abs(okBox.x + okBox.width / 2 - (micBox.x + micBox.width / 2))).toBeLessThanOrEqual(0.5);
  expect(Math.abs(okBox.y + okBox.height / 2 - (micBox.y + micBox.height / 2))).toBeLessThanOrEqual(0.5);
  expect(Math.abs(okBox.width - micBox.width)).toBeLessThanOrEqual(0.5);

  // Listening, then hearing: the bars are reserved slots, so their boxes do not change with the voice.
  const slots = () =>
    page.evaluate(() => [...document.querySelectorAll('[data-slot="voice-takeover"] [data-level] > span')].map((el) => el.getBoundingClientRect().width));
  const quietSlots = await slots();
  expect(quietSlots.length).toBeGreaterThanOrEqual(30);
  await setLoudness(page, 0.3);
  await expect(page.locator('[data-slot="voice-takeover"] [data-level]')).toHaveAttribute("data-level", "speaking");
  expect(await slots()).toEqual(quietSlots);
  expect(await rects(page)).toEqual(before);

  // Tapping the SAME spot again finishes: transcribing, OK dimmed and disabled, the bin still live.
  await page.mouse.click(micBox.x + micBox.width / 2, micBox.y + micBox.height / 2);
  await expect(status(page)).toHaveText(en["composer.voice.transcribing"]);
  await expect(ok).toBeDisabled();
  await expect(page.getByRole("button", { name: en["composer.mic.discardAria"] })).toBeEnabled();
  expect(await rects(page)).toEqual(before);

  // The transcript lands in the box, the takeover goes, the composer is back in the same box.
  await expect(page.getByRole("textbox", { name: en["composer.placeholder.reply"] })).toHaveValue(TRANSCRIPT);
  await expect(region).toHaveCount(0);
  expect(await rects(page)).toEqual(before);
});

test("three seconds of quiet after speech finishes the clip by itself; quiet alone never does", async ({ page }) => {
  await page.goto("/pane/w1:p1");
  await page.getByRole("button", { name: en["composer.mic.recordAria"] }).click();
  await expect(page.getByRole("group", { name: en["composer.voice.regionAria"] })).toBeVisible();

  // A quiet room: nothing for 4 s, longer than the countdown, and the clip is still recording.
  await page.waitForTimeout(4000);
  await expect(page.getByRole("button", { name: en["composer.voice.okAria"] })).toBeEnabled();

  await setLoudness(page, 0.3);
  await expect(page.locator('[data-slot="voice-takeover"] [data-level]')).toHaveAttribute("data-level", "speaking");
  await page.waitForTimeout(700);
  await setLoudness(page, 0);
  await expect(page.locator('[data-slot="voice-takeover"] [data-level]')).toHaveAttribute("data-level", "quiet");
  // The ring has started to close, and the clip has not ended yet.
  await expect(page.locator('[data-slot="voice-takeover"] svg[viewBox="-24 -24 48 48"]')).toHaveCSS("opacity", "1");
  await expect(status(page)).toHaveText(en["composer.voice.listening"]);
  // Then transcription starts with no tap.
  await expect(status(page)).toHaveText(en["composer.voice.transcribing"], { timeout: 6000 });
  await expect(page.getByRole("textbox", { name: en["composer.placeholder.reply"] })).toHaveValue(TRANSCRIPT, { timeout: 8000 });
});

test("the bin throws the clip away and gives the mic back, the microphone released", async ({ page }) => {
  await page.goto("/pane/w1:p1");
  const mic = page.getByRole("button", { name: en["composer.mic.recordAria"] });
  await expect(mic).toBeVisible();
  const before = await rects(page);
  await mic.click();
  await page.getByRole("button", { name: en["composer.mic.discardAria"] }).click();
  await expect(page.getByRole("group", { name: en["composer.voice.regionAria"] })).toHaveCount(0);
  await expect(mic).toBeFocused();
  expect(await rects(page)).toEqual(before);
  // The one audio context the page made for the meter is closed: nothing keeps listening.
  await expect
    .poll(() =>
      page.evaluate(() => {
        return window.__voice?.metered.map((context) => context.state);
      }),
    )
    .toEqual(["closed"]);
});

test("Escape discards the clip", async ({ page }) => {
  await page.goto("/pane/w1:p1");
  await page.getByRole("button", { name: en["composer.mic.recordAria"] }).click();
  await expect(page.getByRole("group", { name: en["composer.voice.regionAria"] })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: en["composer.voice.regionAria"] })).toHaveCount(0);
});
