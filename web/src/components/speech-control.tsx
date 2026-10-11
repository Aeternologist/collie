import { useEffect, useRef, useState, type ReactNode } from "react";
import { AudioLines, Cpu, Download, Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SectionLabel } from "@/components/ui/section-label";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { useStoredModel } from "@/hooks/use-stored-model";
import { useLocale } from "@/hooks/use-locale";
import {
  fetchWhistleStatus,
  removeWhistleModel,
  setWhistleHostEngine,
  startWhistleSetup,
} from "@/lib/api";
import { describeThrownError } from "@/lib/api-error-message";
import { dateTime } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import { formatDownloadSize, formatPercent } from "@/lib/machine-units";
import { noteWhistleStatus, refreshOperatorConfig } from "@/lib/operator-config";
import { usePairing } from "@/lib/pairing";
import { useOptionalRootData } from "@/lib/route-data";
import {
  phoneEngineBlock,
  phoneEngineEnv,
  runSttProbe,
  setSttEnginePreference,
  sttModelErrorMessage,
  useHostSttCapability,
  useSttEnginePreference,
  useSttProbeState,
  useWhistleStatus,
  type PhoneEngineBlock,
  type SttEngineChoice,
} from "@/lib/stt";
import { downloadModel, removeModel, SttModelError, type StoredModel } from "@/lib/stt-model";
import { isReadOnly, type SttCapability, type WhistleStatus } from "@/lib/types";

// SETTINGS → VOICE: THE MODEL THAT LETS VOICE BECOME TEXT, AND WHERE IT RUNS (ADR 0096).
//
// Two cards, in the order a person works through them. First Whistle, the small speech model both
// engines run, with the credit to the people who made it and two steps: put it on the host, then set
// it up on this phone. Then the Speech engine, the choice this device makes between the two, which
// depends on what the steps above produced.
//
// THE HOST DOWNLOADS, NOT THE PHONE, AND ONLY ON A TAP. "Download to host" asks the host to fetch the
// 16.9 MB once; "Set up on this phone" copies it from the host. Nothing here runs by itself, and a
// phone never calls a third party (Decision 7). Downloading to the host is a write, so a read-only
// device sees one sentence instead of the button. Copying to the phone is a read, so any paired device
// may.
//
// THIS FILE HAS TWO HALVES, as notify-prefs-control.tsx does. `SpeechCards` is the view: every fact
// it draws arrives as a prop, so the playground can show each state with no host behind it.
// `SpeechControl` is the controller: it reads the stores, polls, and owns the taps.
//
// THE BOX DOES NOT MOVE ON A STATE (DESIGN.md §2). Each row is at least one 44px control tall, and a
// download's bar takes the place of the button that started it, so a tap does not shift the rows
// under it. The few rows that appear (the details once the model is ready, the phone step once the
// host has something to copy) do so because the person's own tap or the host's own answer made them
// true. A reason a choice is off is written once, under the choice, and nowhere else.

/** Cactus Compute made Whistle. The credit names them and links to them. */
export const CACTUS_URL = "https://cactuscompute.com";
/** The model's page, and the base of a link to one revision of it. */
export const WHISTLE_PAGE_URL = "https://huggingface.co/Cactus-Compute/whistle";

/** A full Hugging Face revision is a 40-character commit hash; only that shape becomes a link. */
const FULL_REVISION = /^[0-9a-f]{40}$/;

/** The reason "This phone" is off for a reason of the browser, in words. */
const BLOCK_KEYS = {
  insecure: "settings.speech.engine.why.insecure",
  browser: "settings.speech.engine.why.browser",
  "wasm-csp": "settings.speech.engine.why.wasmCsp",
  engine: "settings.speech.engine.why.engine",
} as const satisfies Record<Exclude<PhoneEngineBlock, "host-not-ready">, MessageKey>;

/** The phone's own download, if one is under way. */
export type PhoneCopy = { received: number; total: number } | null;

export interface SpeechCardsProps {
  /** The host's model status. `null`: this collie offers none (an older bridge, or a crew member). */
  whistle: WhistleStatus | null;
  /** The host's speech provider, as `/api/config` says it. `null`: none is configured. */
  hostStt: SttCapability | null;
  /** This device may set up and change the host's model (the same rule every other write uses). */
  canWrite: boolean;
  /** What this device asked for. */
  engine: SttEngineChoice;
  /** Why "This phone" cannot run, if it cannot. */
  block: PhoneEngineBlock | null;
  /** The phone's own copy: `null` none, `undefined` still looking. */
  local: StoredModel | null | undefined;
  /** The browser promised to keep the copy when space runs low. */
  persisted: boolean;
  /** The phone's download, while it runs. */
  copy: PhoneCopy;
  /** A failed host action or phone copy, in words. */
  hostError: string | null;
  phoneError: string | null;
  /** The host action in flight, so its button cannot be tapped twice. */
  hostBusy: boolean;
  /** The second tap of "Remove from host" is armed. */
  confirmingRemove: boolean;
  onEngine: (choice: SttEngineChoice) => void;
  onSetup: () => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
  onHostEngine: (on: boolean) => void;
  onPhoneDownload: () => void;
  onPhoneRemove: () => void;
}

/** A thin determinate bar. `fraction` is 0..1. The same bar the update screen draws. */
function Bar({ fraction, label }: { fraction: number; label: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={formatPercent(fraction)}
      className="h-1 w-full overflow-hidden rounded-md bg-muted"
    >
      <div className="h-full bg-status-working motion-safe:transition-[width]" style={{ width: `${percent}%` }} />
    </div>
  );
}

/** A progress line: the bar and "7.3 MB of 16.9 MB" under it. Both numbers share the model's unit. */
function Progress({ received, total, label }: { received: number; total: number; label: string }) {
  return (
    <div className="space-y-1.5">
      <Bar fraction={total > 0 ? received / total : 0} label={label} />
      <p className="text-xs tabular-nums text-muted-foreground">
        {t("settings.speech.progress", { received: formatDownloadSize(received), total: formatDownloadSize(total) })}
      </p>
    </div>
  );
}

/** How an outside link looks here, as in the cache sheet and the launcher help: underlined, no icon. */
const LINK_CLASS =
  "break-words underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function ExternalLink({ href, label, children }: { href: string; label?: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" aria-label={label} className={LINK_CLASS}>
      {children}
    </a>
  );
}

/**
 * A sentence with one link in it. The message carries `{link}` where the link goes, so a language
 * that puts the name elsewhere in the sentence still reads right.
 */
function SentenceWithLink({ message, link }: { message: MessageKey; link: ReactNode }) {
  const [before = "", after = ""] = t(message, { link: "{link}" }).split("{link}");
  return (
    <>
      {before}
      {link}
      {after}
    </>
  );
}

/** The model's version: the first seven characters of the Hugging Face revision, linked to that revision. */
function Version({ revision, sha256 }: { revision: string | undefined; sha256: string | undefined }) {
  if (revision === undefined) return <>{sha256 === undefined ? "" : sha256.slice(0, 7)}</>;
  const short = revision.slice(0, 7);
  if (!FULL_REVISION.test(revision)) return <>{short}</>;
  return (
    <ExternalLink href={`${WHISTLE_PAGE_URL}/tree/${revision}`} label={t("settings.speech.detail.versionLink", { revision: short })}>
      {short}
    </ExternalLink>
  );
}

/** The two cards, drawn from what they are told. No store, no network. */
export function SpeechCards(props: SpeechCardsProps) {
  useLocale();
  const { whistle, local } = props;
  // Nothing to offer: this host has no Whistle and this phone holds no copy.
  if (whistle === null && !local) return null;
  return (
    <>
      <WhistleCard {...props} />
      <EngineCard {...props} />
    </>
  );
}

function WhistleCard(props: SpeechCardsProps) {
  const { whistle } = props;
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start gap-3 p-4">
        <AudioLines className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 space-y-1">
          <div className="font-medium">{t("settings.speech.whistle.title")}</div>
          <p className="text-sm text-muted-foreground">
            <SentenceWithLink
              message="settings.speech.credit"
              link={<ExternalLink href={CACTUS_URL}>{t("settings.speech.credit.maker")}</ExternalLink>}
            />
          </p>
          <p className="text-sm text-muted-foreground">
            <SentenceWithLink
              message="settings.speech.licence"
              link={<ExternalLink href={WHISTLE_PAGE_URL}>{t("settings.speech.licence.page")}</ExternalLink>}
            />
          </p>
        </div>
      </div>
      {whistle !== null && <HostStep {...props} whistle={whistle} />}
      <PhoneStep {...props} />
    </Card>
  );
}

function Step({ id, heading, children }: { id: string; heading: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3 border-t border-border p-4">
      <h3 id={id}>
        <SectionLabel>{heading}</SectionLabel>
      </h3>
      {children}
    </section>
  );
}

function Details({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 break-words">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function HostStep({
  whistle,
  canWrite,
  hostError,
  hostBusy,
  confirmingRemove,
  onSetup,
  onAskRemove,
  onCancelRemove,
  onRemove,
  onHostEngine,
}: SpeechCardsProps & { whistle: WhistleStatus }) {
  const size = formatDownloadSize(whistle.bytes);
  const taken = whistle.hostTaken && !whistle.hostEngine;
  return (
    <Step id="speech-host-step" heading={t("settings.speech.host.heading")}>
      {whistle.state === "absent" &&
        (canWrite ? (
          <div className="space-y-2">
            <Button className="h-11" disabled={hostBusy} onClick={onSetup}>
              {hostBusy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
              {t("settings.speech.host.download", { size })}
            </Button>
            <p className="text-xs text-muted-foreground">{t("settings.speech.host.absent")}</p>
          </div>
        ) : (
          <p className="text-sm">{t("settings.speech.host.readOnly")}</p>
        ))}

      {whistle.state === "downloading" && (
        <div className="space-y-2">
          <p className="text-sm">{t("settings.speech.host.downloading")}</p>
          <Progress received={whistle.received ?? 0} total={whistle.bytes} label={t("settings.speech.progressAria")} />
        </div>
      )}

      {whistle.state === "failed" && (
        <div className="space-y-2">
          <p className="text-sm font-medium">{t("settings.speech.host.failed")}</p>
          {whistle.reason !== undefined && <p className="text-xs text-muted-foreground">{whistle.reason}</p>}
          {canWrite ? (
            <Button className="h-11" variant="outline" disabled={hostBusy} onClick={onSetup}>
              {hostBusy && <Loader2 className="size-4 animate-spin" />}
              {t("settings.speech.host.retry")}
            </Button>
          ) : (
            <p className="text-sm">{t("settings.speech.host.readOnly")}</p>
          )}
        </div>
      )}

      {whistle.state === "ready" && (
        <>
          <Details
            rows={[
              { label: t("settings.speech.detail.model"), value: t("settings.speech.whistle.title") },
              { label: t("settings.speech.detail.version"), value: <Version revision={whistle.revision} sha256={whistle.sha256} /> },
              { label: t("settings.speech.detail.size"), value: size },
              ...(whistle.sha256 === undefined
                ? []
                : [
                    {
                      label: t("settings.speech.detail.checksum"),
                      // The full value is one hover or long-press away; eight characters is what a person compares.
                      value: (
                        <span className="font-mono text-xs" title={whistle.sha256}>
                          {`sha256 ${whistle.sha256.slice(0, 8)}…`}
                        </span>
                      ),
                    },
                  ]),
              ...(whistle.fetchedAt === undefined || Number.isNaN(Date.parse(whistle.fetchedAt))
                ? []
                : [{ label: t("settings.speech.detail.downloaded"), value: dateTime(Date.parse(whistle.fetchedAt)) }]),
            ]}
          />
          <div className="flex min-h-11 items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium" id="speech-host-label">
                {t("settings.speech.host.use.label")}
              </div>
              <p className="text-xs leading-snug text-muted-foreground">{t("settings.speech.host.use.description")}</p>
            </div>
            <div className="flex h-6 w-11 shrink-0 items-center justify-center">
              <Switch
                checked={whistle.hostEngine}
                onCheckedChange={onHostEngine}
                disabled={!canWrite || hostBusy || taken}
                aria-labelledby="speech-host-label"
                aria-describedby={taken ? "speech-host-taken" : undefined}
              />
            </div>
          </div>
          {taken && (
            <p id="speech-host-taken" className="text-xs text-muted-foreground">
              {t("settings.speech.host.use.taken")}
            </p>
          )}
          {canWrite && !confirmingRemove && (
            <Button variant="outline" className="h-11" onClick={onAskRemove}>
              {t("settings.speech.host.remove")}
            </Button>
          )}
          {canWrite && confirmingRemove && (
            <div className="space-y-2">
              <p className="text-xs text-foreground">{t("settings.speech.host.remove.confirm")}</p>
              <div className="flex gap-2">
                <Button variant="ghost" className="h-11" disabled={hostBusy} onClick={onCancelRemove}>
                  {t("settings.speech.host.remove.cancel")}
                </Button>
                <Button variant="destructive" className="h-11" disabled={hostBusy} onClick={onRemove}>
                  {hostBusy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  {t("settings.speech.host.remove.action")}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
      {hostError !== null && (
        <p role="status" className="text-xs text-status-blocked">
          {hostError}
        </p>
      )}
    </Step>
  );
}

/** The browser's own reason "This phone" cannot run the engine, or `null`. */
function browserBlock(block: PhoneEngineBlock | null): Exclude<PhoneEngineBlock, "host-not-ready"> | null {
  return block === null || block === "host-not-ready" ? null : block;
}

function PhoneStep({ whistle, block, local, persisted, copy, phoneError, onPhoneDownload, onPhoneRemove }: SpeechCardsProps) {
  const hostReady = whistle?.state === "ready";
  // Nothing to say about the phone until the host has a model to copy, or the phone has one of its own.
  if (!hostReady && !local) return null;
  const newer = local !== null && local !== undefined && hostReady && whistle?.sha256 !== undefined && whistle.sha256 !== local.sha256;
  const why = browserBlock(block);
  const size = formatDownloadSize(whistle?.bytes ?? local?.bytes ?? 0);
  return (
    <Step id="speech-phone-step" heading={t("settings.speech.phone.heading")}>
      {copy !== null ? (
        <div className="space-y-2">
          <p className="text-sm">{t("settings.speech.phone.copying")}</p>
          <Progress received={copy.received} total={copy.total} label={t("settings.speech.progressAria")} />
        </div>
      ) : local ? (
        <>
          <p className="text-sm font-medium">{t("settings.speech.phone.ready")}</p>
          <Details
            rows={[{ label: t("settings.speech.detail.version"), value: <Version revision={local.revision} sha256={local.sha256} /> }]}
          />
          <p className="text-xs text-muted-foreground">
            {persisted ? t("settings.speech.phone.kept") : t("settings.speech.phone.mayClear")}
          </p>
          {newer && (
            <div className="flex min-h-11 items-center justify-between gap-3">
              <span className="min-w-0 text-sm">{t("settings.speech.phone.newer")}</span>
              <Button className="h-11 shrink-0" disabled={why !== null} onClick={onPhoneDownload}>
                {t("settings.speech.phone.update")}
              </Button>
            </div>
          )}
          <Button variant="outline" className="h-11" onClick={onPhoneRemove}>
            {t("settings.speech.phone.remove")}
          </Button>
        </>
      ) : why !== null ? (
        // This browser cannot run the engine, so a button would only lead to a dead end. The reason
        // stands where the button would be, and is not repeated under the engine choice.
        <p className="text-sm">{t(BLOCK_KEYS[why])}</p>
      ) : (
        <div className="space-y-2">
          <Button className="h-11" disabled={local === undefined} onClick={onPhoneDownload}>
            <Download className="size-4" />
            {t("settings.speech.phone.setup", { size })}
          </Button>
          <p className="text-xs text-muted-foreground">{t("settings.speech.phone.setupNote")}</p>
        </div>
      )}
      {phoneError !== null && (
        <p role="status" className="text-xs text-status-blocked">
          {phoneError}
        </p>
      )}
    </Step>
  );
}

/** What the host's provider is called on screen. Whistle has a name; any other shows its id. */
function providerName(provider: string): string {
  return provider === "whistle" ? t("settings.speech.whistle.title") : provider;
}

function EngineCard({ whistle, hostStt, engine, block, local, onEngine }: SpeechCardsProps) {
  const hostReady = whistle?.state === "ready";
  const hostAvailable = hostStt !== null && hostStt.available;
  const why = browserBlock(block);
  // Whether the phone step is on screen. It shows the browser's reason where its button would be, so
  // the reason is written there and this card does not say it a second time.
  const phoneStepShown = hostReady || Boolean(local);
  const phoneOff = local === null || why !== null;
  // The row shows what will actually run: a stored "phone" this device cannot honour reads as Host,
  // while the stored choice itself is kept (a probe that failed once should not erase the preference).
  const shown: SttEngineChoice = engine === "phone" && !phoneOff ? "phone" : "host";

  let phoneReason: string | null = null;
  if (local === null) {
    if (!phoneStepShown) phoneReason = why !== null ? t(BLOCK_KEYS[why]) : t("settings.speech.engine.why.hostFirst");
    else phoneReason = t("settings.speech.engine.why.setupFirst");
  } else if (why !== null) {
    phoneReason = t(BLOCK_KEYS[why]);
  }

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start gap-3 p-4">
        <Cpu className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="font-medium">{t("settings.speech.engine.title")}</div>
          <p className="text-sm text-muted-foreground">{t("settings.speech.engine.description")}</p>
        </div>
      </div>
      <div className="space-y-2 border-t border-border px-4 py-3">
        <Segmented
          label={t("settings.speech.engine.label")}
          value={shown}
          onChange={onEngine}
          options={[
            { value: "host", label: t("settings.speech.engine.host"), disabled: !hostAvailable },
            { value: "phone", label: t("settings.speech.engine.phone"), disabled: phoneOff },
          ]}
        />
        {phoneReason !== null && <p className="text-xs text-muted-foreground">{phoneReason}</p>}
        <p className="text-xs text-muted-foreground">
          {hostAvailable
            ? t("settings.speech.engine.hostUses", { provider: providerName(hostStt.provider) })
            : t("settings.speech.engine.why.noHost")}
        </p>
      </div>
    </Card>
  );
}

/** How often the host is asked while its download runs. Only while the section is on screen. */
export const WHISTLE_POLL_MS = 1000;
/** Failed polls in a row after which the polling stops, so a host that went away is not asked forever. */
const POLL_FAILURE_LIMIT = 10;

/**
 * The Speech cards, wired. Write access is read the way the dashboard reads it: the bridge's device
 * gate (`isReadOnly`, from the root loader) or a refused pairing, either of which makes this device
 * read-only. Nothing here decides it by itself, and the bridge still enforces it on every write.
 */
export function SpeechControl() {
  useLocale();
  const root = useOptionalRootData();
  const { refused } = usePairing();
  const canWrite = !isReadOnly(root?.device) && !refused;
  const whistle = useWhistleStatus();
  const hostStt = useHostSttCapability();
  const engine = useSttEnginePreference();
  const probe = useSttProbeState();
  const { model: local, persisted } = useStoredModel();

  const [copy, setCopy] = useState<PhoneCopy>(null);
  const [hostError, setHostError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [hostBusy, setHostBusy] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const copyAbort = useRef<AbortController | null>(null);

  // The reason "This phone" is off. Unknown while the first look is under way counts as "has a copy",
  // so the option does not flash disabled and then open.
  const block = phoneEngineBlock({
    env: phoneEngineEnv(),
    probe,
    haveLocalModel: local !== null,
    hostReady: whistle?.state === "ready",
  });

  // Ask the worker once whether this browser runs the engine, as soon as the card is on screen and
  // nothing else already rules the phone out. Costs one short-lived worker, once per page session.
  const visible = whistle !== null || local !== null;
  const envOk = block === null || block === "host-not-ready";
  useEffect(() => {
    if (visible && envOk) void runSttProbe();
  }, [visible, envOk]);

  // THE POLL: once a second, only while the host is downloading and only while the page is visible.
  const downloading = whistle?.state === "downloading";
  useEffect(() => {
    if (!downloading) return;
    const controller = new AbortController();
    let inFlight = false;
    let failures = 0;
    async function poll(): Promise<void> {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        noteWhistleStatus(await fetchWhistleStatus(controller.signal));
        failures = 0;
      } catch {
        failures += 1;
        if (failures >= POLL_FAILURE_LIMIT) clearInterval(id);
      } finally {
        inFlight = false;
      }
    }
    const id = setInterval(() => void poll(), WHISTLE_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [downloading]);

  // Leaving the page ends a copy in progress; nothing is kept from a half-finished one.
  useEffect(() => () => copyAbort.current?.abort(), []);

  async function hostAction(work: () => Promise<WhistleStatus>, refresh = false): Promise<void> {
    setHostBusy(true);
    setHostError(null);
    try {
      noteWhistleStatus(await work());
      // The host's provider may have changed with it, and the microphone follows the provider.
      if (refresh) void refreshOperatorConfig();
    } catch (error) {
      setHostError(describeThrownError(error));
    } finally {
      setHostBusy(false);
      setConfirmingRemove(false);
    }
  }

  async function phoneDownload(): Promise<void> {
    if (whistle === null) return;
    const controller = new AbortController();
    copyAbort.current = controller;
    setPhoneError(null);
    setCopy({ received: 0, total: whistle.bytes });
    try {
      await downloadModel(whistle, (received, total) => setCopy({ received, total }), controller.signal);
      // The first worker to load once the copy exists is stored by the service worker, so the engine
      // also starts offline. A probe is a worker load.
      void runSttProbe();
    } catch (error) {
      if (!(error instanceof SttModelError && error.code === "aborted")) setPhoneError(sttModelErrorMessage(error));
    } finally {
      setCopy(null);
      copyAbort.current = null;
    }
  }

  return (
    <SpeechCards
      whistle={whistle}
      hostStt={hostStt}
      canWrite={canWrite}
      engine={engine}
      block={block}
      local={local}
      persisted={persisted}
      copy={copy}
      hostError={hostError}
      phoneError={phoneError}
      hostBusy={hostBusy}
      confirmingRemove={confirmingRemove}
      onEngine={setSttEnginePreference}
      onSetup={() => void hostAction(startWhistleSetup)}
      onAskRemove={() => setConfirmingRemove(true)}
      onCancelRemove={() => setConfirmingRemove(false)}
      onRemove={() => void hostAction(removeWhistleModel, true)}
      onHostEngine={(on) => void hostAction(() => setWhistleHostEngine(on), true)}
      onPhoneDownload={() => void phoneDownload()}
      onPhoneRemove={() => {
        setPhoneError(null);
        void removeModel();
      }}
    />
  );
}
