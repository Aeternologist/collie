import { useEffect, useRef, useState } from "react";
import { AudioLines, Download, Loader2, Mic, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
  useSttEnginePreference,
  useSttProbeState,
  useWhistleStatus,
  type PhoneEngineBlock,
  type SttEngineChoice,
} from "@/lib/stt";
import { downloadModel, removeModel, SttModelError, type StoredModel } from "@/lib/stt-model";
import { isReadOnly, type WhistleStatus } from "@/lib/types";

// SETTINGS → SPEECH: WHERE VOICE BECOMES TEXT, AND THE MODEL THAT LETS A PHONE DO IT (ADR 0096).
//
// Two cards. The first is the per-device engine choice, Host or This phone. The second is Whistle,
// the small speech model both engines run: where the host stands with it, and whether this phone has
// its own copy.
//
// THE HOST DOWNLOADS, NOT THE PHONE, AND ONLY ON A TAP. "Set up Whistle" asks the host to fetch the
// 16.9 MB once; "Download to this phone" copies it from the host. Nothing here runs by itself, and a
// phone never calls a third party (Decision 7). Setting up the host is a write, so a read-only device
// sees one sentence instead of the button. Copying to the phone is a read, so any paired device may.
//
// THIS FILE HAS TWO HALVES, as notify-prefs-control.tsx does. `SpeechCards` is the view: every fact
// it draws arrives as a prop, so the playground can show each state with no host behind it.
// `SpeechControl` is the controller: it reads the stores, polls, and owns the taps.
//
// THE BOX DOES NOT MOVE ON A STATE (DESIGN.md §2). Each row is at least one 44px control tall, and a
// download's bar takes the place of the button that started it, so a tap does not shift the rows
// under it. The few rows that appear (the host-engine switch once the model is ready, the persist line
// once a copy exists) do so because the person's own tap or the host's own answer made them true.

/** The reason "This phone" is off, in words. */
const BLOCK_KEYS = {
  insecure: "settings.speech.engine.why.insecure",
  browser: "settings.speech.engine.why.browser",
  "wasm-csp": "settings.speech.engine.why.wasmCsp",
  engine: "settings.speech.engine.why.engine",
  "host-not-ready": "settings.speech.engine.why.hostNotReady",
} as const satisfies Record<PhoneEngineBlock, MessageKey>;

/** The phone's own download, if one is under way. */
export type PhoneCopy = { received: number; total: number } | null;

export interface SpeechCardsProps {
  /** The host's model status. `null`: this collie offers none (an older bridge, or a crew member). */
  whistle: WhistleStatus | null;
  /** This device may set up and change the host's model (the same rule every other write uses). */
  canWrite: boolean;
  /** What this device asked for. */
  engine: SttEngineChoice;
  /** Why "This phone" cannot be chosen, if it cannot. */
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
        {t("settings.speech.whistle.progress", { received: formatDownloadSize(received), total: formatDownloadSize(total) })}
      </p>
    </div>
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
      <EngineCard {...props} />
      <WhistleCard {...props} />
    </>
  );
}

function EngineCard({ engine, block, local, onEngine }: SpeechCardsProps) {
  // The row shows what will actually run: a stored "phone" the browser cannot honour reads as Host,
  // while the stored choice itself is kept (a probe that failed once should not erase the preference).
  const shown: SttEngineChoice = engine === "phone" && block === null ? "phone" : "host";
  const needsModel = shown === "phone" && local === null;
  const reason = block === null ? null : t(BLOCK_KEYS[block]);
  const note = reason ?? (needsModel ? t("settings.speech.engine.needsModel") : null);
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start gap-3 p-4">
        <Mic className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="font-medium">{t("settings.speech.engine.title")}</div>
          <p className="text-sm text-muted-foreground">{t("settings.speech.engine.description")}</p>
        </div>
      </div>
      <div className="border-t border-border px-4 py-3">
        <Segmented
          label={t("settings.speech.engine.label")}
          value={shown}
          onChange={onEngine}
          options={[
            { value: "host", label: t("settings.speech.engine.host") },
            { value: "phone", label: t("settings.speech.engine.phone"), disabled: block !== null },
          ]}
        />
        {note !== null && <p className="mt-2 text-xs text-muted-foreground">{note}</p>}
      </div>
    </Card>
  );
}

function WhistleCard(props: SpeechCardsProps) {
  const { whistle } = props;
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start gap-3 p-4">
        <AudioLines className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="font-medium">{t("settings.speech.whistle.title")}</div>
          <p className="text-sm text-muted-foreground">
            {t("settings.speech.whistle.description", { size: formatDownloadSize(whistle?.bytes ?? 0) })}
          </p>
        </div>
      </div>
      {whistle !== null && <HostRows {...props} whistle={whistle} />}
      <PhoneRows {...props} />
    </Card>
  );
}

function HostRows({
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
    <>
      {whistle.state === "absent" && (
        <div className="space-y-2 border-t border-border p-4">
          <p className="text-sm text-muted-foreground">{t("settings.speech.whistle.absent")}</p>
          {canWrite ? (
            <Button className="h-11" disabled={hostBusy} onClick={onSetup}>
              {hostBusy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
              {t("settings.speech.whistle.setup", { size })}
            </Button>
          ) : (
            <p className="text-sm">{t("settings.speech.whistle.readOnly")}</p>
          )}
        </div>
      )}

      {whistle.state === "downloading" && (
        <div className="space-y-2 border-t border-border p-4">
          <p className="text-sm">{t("settings.speech.whistle.downloading")}</p>
          <Progress
            received={whistle.received ?? 0}
            total={whistle.bytes}
            label={t("settings.speech.whistle.progressAria")}
          />
        </div>
      )}

      {whistle.state === "failed" && (
        <div className="space-y-2 border-t border-border p-4">
          <p className="text-sm font-medium">{t("settings.speech.whistle.failed")}</p>
          {whistle.reason !== undefined && <p className="text-xs text-muted-foreground">{whistle.reason}</p>}
          {canWrite ? (
            <Button className="h-11" variant="outline" disabled={hostBusy} onClick={onSetup}>
              {hostBusy && <Loader2 className="size-4 animate-spin" />}
              {t("settings.speech.whistle.retry")}
            </Button>
          ) : (
            <p className="text-sm">{t("settings.speech.whistle.readOnly")}</p>
          )}
        </div>
      )}

      {whistle.state === "ready" && (
        <>
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <span className="font-medium">{t("settings.speech.whistle.ready", { size })}</span>
            </div>
            {canWrite && !confirmingRemove && (
              <Button variant="outline" className="h-11 shrink-0" onClick={onAskRemove}>
                {t("settings.speech.whistle.remove")}
              </Button>
            )}
          </div>
          {canWrite && confirmingRemove && (
            <div className="space-y-2 border-t border-border px-4 py-3">
              <p className="text-xs text-foreground">{t("settings.speech.whistle.remove.confirm")}</p>
              <div className="flex gap-2">
                <Button variant="ghost" className="h-11" disabled={hostBusy} onClick={onCancelRemove}>
                  {t("settings.speech.whistle.remove.cancel")}
                </Button>
                <Button variant="destructive" className="h-11" disabled={hostBusy} onClick={onRemove}>
                  {hostBusy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  {t("settings.speech.whistle.remove.action")}
                </Button>
              </div>
            </div>
          )}
          <div className="border-t border-border px-4 py-3">
            <div className="flex min-h-11 items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium" id="speech-host-label">
                  {t("settings.speech.whistle.host.label")}
                </div>
                <p className="text-xs leading-snug text-muted-foreground">{t("settings.speech.whistle.host.description")}</p>
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
              <p id="speech-host-taken" className="mt-1 text-xs text-muted-foreground">
                {t("settings.speech.whistle.host.taken")}
              </p>
            )}
          </div>
        </>
      )}
      {hostError !== null && (
        <p role="status" className="border-t border-border px-4 py-2.5 text-xs text-status-blocked">
          {hostError}
        </p>
      )}
    </>
  );
}

function PhoneRows({ whistle, block, local, persisted, copy, phoneError, onPhoneDownload, onPhoneRemove }: SpeechCardsProps) {
  const hostReady = whistle?.state === "ready";
  const newer = local !== null && local !== undefined && hostReady && whistle?.sha256 !== undefined && whistle.sha256 !== local.sha256;
  // Nothing to say about the phone until the host has a model to copy, or the phone has one of its own.
  if (!hostReady && !local) return null;
  const reason = block !== null && block !== "host-not-ready" ? t(BLOCK_KEYS[block]) : null;
  return (
    <div className="space-y-2 border-t border-border px-4 py-3">
      {copy !== null ? (
        <>
          <p className="text-sm">{t("settings.speech.whistle.phone.copying")}</p>
          <Progress received={copy.received} total={copy.total} label={t("settings.speech.whistle.progressAria")} />
        </>
      ) : local ? (
        <>
          <div className="flex min-h-11 items-center justify-between gap-3">
            <span className="min-w-0 text-sm font-medium">
              {t("settings.speech.whistle.phone.have", { size: formatDownloadSize(local.bytes) })}
            </span>
            <Button variant="outline" className="h-11 shrink-0" onClick={onPhoneRemove}>
              {t("settings.speech.whistle.phone.remove")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {persisted ? t("settings.speech.whistle.phone.kept") : t("settings.speech.whistle.phone.mayClear")}
          </p>
          {newer && (
            <div className="flex min-h-11 items-center justify-between gap-3">
              <span className="min-w-0 text-sm">{t("settings.speech.whistle.phone.newer")}</span>
              <Button className="h-11 shrink-0" disabled={reason !== null} onClick={onPhoneDownload}>
                {t("settings.speech.whistle.phone.update")}
              </Button>
            </div>
          )}
        </>
      ) : (
        <>
          <Button className="h-11" disabled={reason !== null || local === undefined} onClick={onPhoneDownload}>
            <Download className="size-4" />
            {t("settings.speech.whistle.phone.download")}
          </Button>
          {reason !== null && <p className="text-xs text-muted-foreground">{reason}</p>}
        </>
      )}
      {phoneError !== null && (
        <p role="status" className="text-xs text-status-blocked">
          {phoneError}
        </p>
      )}
    </div>
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
