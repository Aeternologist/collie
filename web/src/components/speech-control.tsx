import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AudioLines,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Info,
  Loader2,
  Mic,
  Server,
  Smartphone,
  Trash2,
  TriangleAlert,
  Wrench,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapse } from "@/components/ui/collapse";
import { Notice } from "@/components/ui/notice";
import { SectionLabel } from "@/components/ui/section-label";
import { BottomSheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import {
  AudioLine,
  FactsSheet,
  Facts,
  HostCommand,
  InfoButton,
  optionName,
  ReadOnlyHostBanner,
  Ring,
  StateWord,
  TERMINAL_COMMANDS,
  TerminalSetup,
  terminalOnly,
  TierLabel,
  Zone,
  type AboutId,
} from "@/components/voice-parts";
import { VoiceEmpty } from "@/components/voice-empty";
import { useStoredModel } from "@/hooks/use-stored-model";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { fetchSttHost, fetchWhistleStatus, removeWhistleModel, setSttHost, startWhistleSetup } from "@/lib/api";
import { describeThrownError } from "@/lib/api-error-message";
import { dateTime } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import { formatDownloadSize, formatPercent } from "@/lib/machine-units";
import { voicePagePath, type VoicePage } from "@/lib/nav";
import { noteWhistleStatus, refreshOperatorConfig } from "@/lib/operator-config";
import { usePairing } from "@/lib/pairing";
import { useOptionalRootData } from "@/lib/route-data";
import { useScope } from "@/lib/session";
import {
  phoneEngineBlock,
  phoneEngineEnv,
  runSttProbe,
  setHandsFreeEnabled,
  setSttEnginePreference,
  sttModelErrorMessage,
  sttRecordingSupported,
  useHandsFree,
  useHostSttCapability,
  useOperatorConfigRead,
  useSttEnginePreference,
  useSttProbeState,
  useWhistleStatus,
  type PhoneEngineBlock,
  type SttEngineChoice,
} from "@/lib/stt";
import { CODEX_CONSENT_ID, CODEX_CONSENT_KEYS, CODEX_TRANSCRIBE_URL } from "@/lib/stt-consent";
import { downloadModel, removeModel, SttModelError, type StoredModel } from "@/lib/stt-model";
import {
  isReadOnly,
  type SttCapability,
  type SttHostChoice,
  type SttHostStatus,
  type SttHostSwitchReason,
  type WhistleStatus,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  askFor,
  browserBlock,
  choiceOf,
  currentHostProvider,
  HOST_OPTIONS,
  hostOptionOf,
  modelChip,
  optionOfChoice,
  phoneChoiceInForce,
  reachOf,
  tierOf,
  voiceStatus,
  type HostOption,
  type ModelChip,
  type VoiceStatus,
} from "@/lib/voice";
import { WHISTLE_MODEL_BYTES } from "@/stt/pins";

// SETTINGS → VOICE: WHERE YOUR SPEECH BECOMES TEXT (ADR 0096, ADR 0097).
//
// A hub and two pages below it. The hub answers the question a person opens Voice to ask, "what
// happens when I press the mic", and holds this phone's own choice in full: On this phone or On
// your host. The host's option reaches every device, so it is ONE row on the hub with a way in; its
// five options live on Host speech, one level down, where a change is a deliberate trip. The model's
// two copies (on the host, on this phone) live on Whistle model, the other page.
//
// THE TWO SCOPES ARE THE STRUCTURE. "Only this phone" and "Every device on your host" are the two
// section labels the hub has, so a person always knows which of the two a tap reaches. A device
// without the write grant sees one banner, and it covers the host's settings only: this phone's own
// choice and hands-free stay live.
//
// THE HOST'S OPTION CHANGES ONLY AMONG THREE (ADR 0097). Whistle, ChatGPT (Codex) and Off carry no
// key and run no command the operator chose. Your own command and a speech service are set up in a
// terminal on the host: the page prints the fixed command and a "Check again", never a field. A
// change that sends audio further than before asks first, in a sheet; ChatGPT always opens its
// consent, the same words `collie stt setup` prints, and nothing is sent before "I accept".
//
// NO SILENT SWITCH (ADR 0096 Decision 12). A phone that chose On this phone and lost its copy is
// paused, and says so with one action (Restore). It does not send audio to the host by itself.
//
// THIS FILE HAS TWO HALVES, as notify-prefs-control.tsx does. `SpeechCards` is the view: every fact
// it draws arrives as a prop, so the playground can show each state with no host behind it.
// `SpeechControl` is the controller: it reads the stores, polls, and owns the taps. The small pieces
// both halves share are in components/voice-parts.tsx; the rules behind the words in lib/voice.ts.
//
// THE BOX DOES NOT MOVE ON A STATE (DESIGN.md §2). A download's bar takes the place of the button
// that started it, and a terminal step opens through `Collapse`.

/** Cactus Compute made Whistle. The credit names them and links to them. */
export const CACTUS_URL = "https://cactuscompute.com";
/** The model's page, and the base of a link to one revision of it. */
export const WHISTLE_PAGE_URL = "https://huggingface.co/Cactus-Compute/whistle";

/** A full Hugging Face revision is a 40-character commit hash; only that shape becomes a link. */
const FULL_REVISION = /^[0-9a-f]{40}$/;

/** The reason "On this phone" is off for a reason of the browser, in words. */
const BLOCK_KEYS = {
  insecure: "settings.speech.engine.why.insecure",
  browser: "settings.speech.engine.why.browser",
  "wasm-csp": "settings.speech.engine.why.wasmCsp",
  engine: "settings.speech.engine.why.engine",
} as const satisfies Record<Exclude<PhoneEngineBlock, "host-not-ready">, MessageKey>;

/** The phone's own download, if one is under way. */
export type PhoneCopy = { received: number; total: number } | null;

/** Which Voice page is drawn: the hub, Host speech, or Whistle model. */
export type VoiceView = "hub" | VoicePage;

export interface SpeechCardsProps {
  /** The page to draw. */
  page: VoiceView;
  /** The host's model status. `null`: this collie offers none (an older bridge, or a crew member). */
  whistle: WhistleStatus | null;
  /** The host's speech provider, as `/api/config` says it. `null`: none is configured. */
  hostStt: SttCapability | null;
  /** The host's provider, who set it and what may be chosen (`GET /api/stt/host`). `null`: not known (an older bridge, or not read yet). */
  host: SttHostStatus | null;
  /** The first read of the host's provider has settled, answered or not. */
  hostRead: boolean;
  /** The choice being sent to the host, while it is in flight. */
  switching: SttHostChoice | null;
  /** A refused switch, in words, written on the Host speech page. */
  providerError: string | null;
  /** The host-wide confirm is open for this choice. */
  confirmTo: SttHostChoice | null;
  /** The ChatGPT consent sheet is open. */
  consentOpen: boolean;
  /** A refused ChatGPT switch, in words, written inside the open consent sheet. */
  consentError: string | null;
  /** This device may set up and change the host's model and option (the same rule every other write uses). */
  canWrite: boolean;
  /** This browser can record at all. */
  recording: boolean;
  /** What this device asked for. */
  engine: SttEngineChoice;
  /** Why "On this phone" cannot run, if it cannot. */
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
  /** A "Check again" read of the host is in flight. */
  checking: boolean;
  /** The second tap of "Remove" on the host's copy is armed. */
  confirmingRemove: boolean;
  /** Hands-free is on for this device. */
  handsFree: boolean;
  /** The info sheet open at first paint. The playground opens one; the page starts with none. */
  initialAbout?: AboutId | null;
  /** The terminal step open at first paint, on Host speech. */
  initialTerminal?: HostOption | null;
  /** The model's details open at first paint, on Whistle model. */
  initialDetails?: boolean;
  onEngine: (choice: SttEngineChoice) => void;
  onHandsFree: (on: boolean) => void;
  /** Download the model to the host. */
  onSetup: () => void;
  /** Download the model to the host, then copy it to this phone once it is there. */
  onSetupBoth: () => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
  /** A host choice was tapped. Whistle and Off are sent at once or after the confirm; ChatGPT opens the consent. */
  onChooseProvider: (choice: SttHostChoice) => void;
  onConfirm: () => void;
  onCancelConfirm: () => void;
  /** "I accept" in the consent sheet: the only path by which a ChatGPT switch reaches the host. */
  onAcceptConsent: () => void;
  onCancelConsent: () => void;
  onPhoneDownload: () => void;
  onPhoneRemove: () => void;
  /** Read the host's option again, after a step in its terminal. */
  onCheckAgain: () => void;
  onOpenPage: (page: VoicePage) => void;
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

/** The first seven characters of a revision, or of the hash when the copy names no revision. */
function shortVersion(revision: string | undefined, sha256: string | undefined): string {
  if (revision !== undefined) return revision.slice(0, 7);
  return sha256 === undefined ? "" : sha256.slice(0, 7);
}

/** The model's version: the first seven characters of the Hugging Face revision, linked to that revision. */
function Version({ revision, sha256 }: { revision: string | undefined; sha256: string | undefined }) {
  const short = shortVersion(revision, sha256);
  if (revision === undefined || !FULL_REVISION.test(revision)) return <>{short}</>;
  return (
    <ExternalLink href={`${WHISTLE_PAGE_URL}/tree/${revision}`} label={t("settings.speech.detail.versionLink", { revision: short })}>
      {short}
    </ExternalLink>
  );
}

/** The model's size, formatted: the host's number, else the phone's, else the size this build pins. */
function modelSize(whistle: WhistleStatus | null, local: StoredModel | null | undefined): string {
  return formatDownloadSize(whistle?.bytes ?? local?.bytes ?? WHISTLE_MODEL_BYTES);
}

/** The host's option, from the status read or the config. `null`: a provider this build does not know. */
function hostOptionNow(props: Pick<SpeechCardsProps, "host" | "hostStt">): HostOption | null {
  return hostOptionOf(currentHostProvider(props.host, props.hostStt));
}

/** The host's option's name, or the provider id as the host sent it when this build does not know it. */
function hostOptionLabel(props: Pick<SpeechCardsProps, "host" | "hostStt">): string {
  const option = hostOptionNow(props);
  return option === null ? currentHostProvider(props.host, props.hostStt) : optionName(option);
}

/** Whether the host's option could serve a request now. */
function hostAvailable(props: Pick<SpeechCardsProps, "host" | "hostStt">): boolean {
  return props.host?.available ?? props.hostStt?.available ?? false;
}

/** The host's own words for why its option does not work, or the plain fallback. */
function hostReason(props: Pick<SpeechCardsProps, "host" | "hostStt">): string {
  return props.host?.reason ?? props.hostStt?.reason ?? t("settings.speech.provider.status.unavailable");
}

/** "Last changed by Pixel 8, 11 Oct 2026, 09:41." Nothing when the host recorded no device. */
function LastChanged({ host }: { host: SttHostStatus | null }) {
  if (host?.changedBy === undefined || host.changedAt === undefined) return null;
  const at = Date.parse(host.changedAt);
  if (Number.isNaN(at)) return null;
  return <p className="text-xs text-muted-foreground">{t("settings.voice.lastChanged", { device: host.changedBy, time: dateTime(at) })}</p>;
}

/** The views, drawn from what they are told. No store, no network. */
export function SpeechCards(props: SpeechCardsProps) {
  useLocale();
  const [about, setAbout] = useState<AboutId | null>(props.initialAbout ?? null);
  const sheets = (
    <>
      <FactsSheet about={about} hostOption={hostOptionNow(props)} size={modelSize(props.whistle, props.local)} onClose={() => setAbout(null)} />
      <HostConfirmSheet {...props} />
      <CodexConsentSheet
        open={props.consentOpen}
        codexBin={props.host?.codexBin ?? "codex"}
        busy={props.switching === "codex"}
        error={props.consentError}
        onAccept={props.onAcceptConsent}
        onCancel={props.onCancelConsent}
      />
    </>
  );
  if (props.page === "host") {
    return (
      <>
        <HostSpeechPage {...props} onAbout={setAbout} />
        {sheets}
      </>
    );
  }
  if (props.page === "model") return <WhistleModelPage {...props} />;
  return (
    <>
      <VoiceHub {...props} onAbout={setAbout} />
      {sheets}
    </>
  );
}

/** Whether the hub has anything to say: a model, a copy, or a host that answered about speech. */
export function voiceHubShown(props: Pick<SpeechCardsProps, "whistle" | "local" | "host" | "hostStt">): boolean {
  return props.whistle !== null || Boolean(props.local) || props.host !== null || props.hostStt !== null;
}

// ── THE HUB ─────────────────────────────────────────────────────────────────────────────────────

type WithAbout = SpeechCardsProps & { onAbout: (about: AboutId) => void };

/** The status card's three lines. */
interface StatusWords {
  where: string;
  word: string;
  detail: string | null;
}

function statusWords(status: VoiceStatus, props: SpeechCardsProps): StatusWords {
  switch (status.kind) {
    case "phone":
      return { where: t("settings.voice.status.phone"), word: t("settings.voice.status.phone.word"), detail: t("settings.voice.status.phone.detail") };
    case "paused":
      return {
        where: t("settings.voice.status.paused"),
        word: t("settings.voice.status.paused.word"),
        detail: t(status.action === "restore" ? "settings.voice.status.paused.detail" : "settings.voice.status.paused.noCopy"),
      };
    case "setup":
      return { where: t("settings.voice.status.setup"), word: t("settings.voice.status.setup.word"), detail: t("settings.voice.status.setup.detail") };
    case "no-recording":
      return {
        where: t("settings.voice.status.noRecording"),
        word: t("settings.voice.status.broken"),
        detail: props.block === "insecure" ? t("settings.speech.engine.why.insecure") : null,
      };
    case "host": {
      const where =
        status.option === "whistle"
          ? t("settings.voice.status.host.whistle")
          : status.option === "chatgpt"
            ? t("settings.voice.status.host.chatgpt")
            : status.option === "service"
              ? t("settings.voice.status.host.service")
              : status.option === "command"
                ? t("settings.voice.status.host.command")
                : t("settings.voice.status.host.other", { provider: status.provider });
      if (status.state === "broken") return { where, word: t("settings.voice.status.broken"), detail: hostReason(props) };
      return { where, word: t("settings.voice.status.works"), detail: null };
    }
  }
}

/**
 * "When you press the mic": where speech becomes text, where audio goes, and whether it works. The
 * action under it fixes the state (Restore, Fix), never a second way to change a setting.
 */
function StatusCard({ status, props }: { status: VoiceStatus; props: SpeechCardsProps }) {
  const words = statusWords(status, props);
  const size = modelSize(props.whistle, props.local);
  return (
    <Card className="gap-0 py-0">
      <div className="space-y-2 p-4">
        <SectionLabel>{t("settings.voice.status.label")}</SectionLabel>
        <p className="font-medium leading-snug">{words.where}</p>
        <AudioLine
          reach={status.reach}
          text={status.kind === "host" && status.option === null ? t("settings.voice.audio.unknown") : undefined}
        />
      </div>
      <div className="space-y-2 border-t border-border px-4 py-3">
        <div className="flex min-h-6 items-center">
          <StateWord state={status.state} word={words.word} />
        </div>
        {words.detail !== null && <p className="text-xs text-muted-foreground">{words.detail}</p>}
        {status.kind === "paused" && status.action === "restore" && (
          <Button className="h-11" disabled={props.copy !== null || browserBlock(props.block) !== null} onClick={props.onPhoneDownload}>
            {props.copy !== null ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            {t("settings.voice.restore", { size })}
          </Button>
        )}
        {status.kind === "host" && status.action === "fix" && (
          <Button variant="outline" className="h-11" onClick={() => props.onOpenPage("host")}>
            <Wrench className="size-4" />
            {t("settings.voice.fix")}
          </Button>
        )}
      </div>
    </Card>
  );
}

/**
 * One of this phone's two choices, as a selectable card. The radio is the top of the card; the info
 * button sits beside it, outside the radio; the setup action, when there is one, sits under it,
 * indented to the text's left edge so it reads as part of the choice.
 */
function ChoiceCard({
  checked,
  disabled,
  icon: Icon,
  title,
  what,
  reach,
  audioText,
  onChoose,
  onAbout,
  children,
}: {
  checked: boolean;
  disabled: boolean;
  icon: typeof Smartphone;
  title: string;
  what: string;
  reach: VoiceStatus["reach"];
  audioText?: string;
  onChoose: () => void;
  onAbout: () => void;
  children?: ReactNode;
}) {
  return (
    <Card className={cn("relative gap-0 py-0", checked && "border-primary")}>
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => {
          if (!checked) onChoose();
        }}
        className="flex min-h-11 w-full items-start gap-3 p-4 pr-14 text-left transition-colors active:bg-muted/60 disabled:active:bg-transparent"
      >
        <Ring checked={checked} />
        <span className={cn("min-w-0 flex-1 space-y-1", disabled && !checked && "opacity-60")}>
          <span className="flex items-center gap-2">
            <span className="text-sm font-medium">{title}</span>
            <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          </span>
          <span className="block text-xs text-muted-foreground">{what}</span>
          <span className="block pt-1">
            <AudioLine reach={reach} text={audioText} />
          </span>
        </span>
      </button>
      <InfoButton name={title} onClick={onAbout} />
      {children !== undefined && <div className="space-y-2 pr-4 pb-4 pl-12">{children}</div>}
    </Card>
  );
}

const SHORT_KEYS = {
  whistle: "settings.voice.short.whistle",
  command: "settings.voice.short.command",
  service: "settings.voice.short.service",
  chatgpt: "settings.voice.short.chatgpt",
} as const satisfies Record<Exclude<HostOption, "off">, MessageKey>;

/** This phone's two choices, with the setup each needs written inside it. */
function PhoneChoices(props: WithAbout) {
  const { engine, block, local, onEngine, onAbout } = props;
  const inForce = phoneChoiceInForce(engine, block);
  const why = browserBlock(block);
  const option = hostOptionNow(props);
  const hostOff = option === "off";
  // "On this phone" needs a copy and a browser that can run it. A copy that is gone while it is
  // chosen keeps it chosen (paused), so the radio stays where the person put it.
  const phoneDisabled = why !== null || (local === null && inForce !== "phone");
  const hostWhat = hostOff
    ? t("settings.voice.choice.host.off")
    : t("settings.voice.choice.host.what", { option: option === null ? currentHostProvider(props.host, props.hostStt) : t(SHORT_KEYS[option]) });
  return (
    <div role="radiogroup" aria-label={t("settings.voice.phone.hint")} className="space-y-2">
      <ChoiceCard
        checked={inForce === "phone"}
        disabled={phoneDisabled}
        icon={Smartphone}
        title={t("settings.speech.phone.heading")}
        what={t("settings.voice.choice.phone.what")}
        reach="phone"
        onChoose={() => onEngine("phone")}
        onAbout={() => onAbout("phone")}
      >
        <PhoneCopyLine {...props} />
      </ChoiceCard>
      <ChoiceCard
        checked={inForce === "host"}
        disabled={hostOff}
        icon={Server}
        title={t("settings.speech.host.heading")}
        what={hostWhat}
        reach={hostOff || option === null ? null : reachOf(option)}
        audioText={hostOff ? t("settings.voice.audio.nothingYet") : option === null ? t("settings.voice.audio.unknown") : undefined}
        onChoose={() => onEngine("host")}
        onAbout={() => onAbout("host")}
      />
    </div>
  );
}

/** The phone choice's own setup line: what its copy of the model needs, and the one button for it. */
function PhoneCopyLine(props: SpeechCardsProps) {
  const { whistle, local, copy, block, engine, canWrite, hostBusy, phoneError, onPhoneDownload, onSetupBoth } = props;
  const why = browserBlock(block);
  const size = modelSize(whistle, local);
  const newer = Boolean(local) && whistle?.state === "ready" && whistle.sha256 !== undefined && whistle.sha256 !== local?.sha256;
  let line: ReactNode;
  if (copy !== null) {
    line = (
      <div className="space-y-2">
        <p className="text-xs">{t("settings.speech.phone.copying")}</p>
        <Progress received={copy.received} total={copy.total} label={t("settings.speech.progressAria")} />
      </div>
    );
  } else if (local) {
    line = (
      <p className="text-xs text-muted-foreground">
        {newer ? t("settings.voice.copy.older") : t("settings.voice.copy.ready", { version: shortVersion(local.revision, local.sha256) })}
      </p>
    );
  } else if (local === null && phoneChoiceInForce(engine, block) === "phone") {
    line = <p className="text-xs">{t("settings.voice.copy.gone")}</p>;
  } else if (why !== null) {
    line = <p className="text-xs">{t(BLOCK_KEYS[why])}</p>;
  } else if (whistle?.state === "ready") {
    line = (
      <>
        <Button variant="outline" className="h-11" disabled={local === undefined} onClick={onPhoneDownload}>
          <Download className="size-4" />
          {t("settings.voice.copy.toPhone", { size })}
        </Button>
        <p className="text-xs text-muted-foreground">{t("settings.voice.copy.toPhone.note")}</p>
      </>
    );
  } else if (whistle?.state === "downloading") {
    line = (
      <div className="space-y-2">
        <p className="text-xs">{t("settings.speech.host.downloading")}</p>
        <Progress received={whistle.received ?? 0} total={whistle.bytes} label={t("settings.speech.progressAria")} />
      </div>
    );
  } else if (whistle === null) {
    line = <p className="text-xs text-muted-foreground">{t("settings.voice.copy.noWhistle")}</p>;
  } else if (!canWrite) {
    line = <p className="text-xs text-muted-foreground">{t("settings.voice.copy.needsHost")}</p>;
  } else {
    // Absent, or a download that failed: one button that does both steps, the host's download and
    // then this phone's copy.
    line = (
      <>
        {whistle.state === "failed" && <p className="text-xs font-medium">{t("settings.speech.host.failed")}</p>}
        <Button variant="outline" className="h-11" disabled={hostBusy || local === undefined} onClick={onSetupBoth}>
          {hostBusy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
          {t("settings.voice.copy.setup", { size })}
        </Button>
        <p className="text-xs text-muted-foreground">{t("settings.voice.copy.setup.note")}</p>
      </>
    );
  }
  return (
    <>
      {line}
      {phoneError !== null && (
        <p role="status" className="text-xs text-status-blocked">
          {phoneError}
        </p>
      )}
    </>
  );
}

/** The hub's one row for the host: what it uses, where audio goes, who changed it, and a way in. */
function HostSummaryRow(props: SpeechCardsProps) {
  const option = hostOptionNow(props);
  const broken = option !== "off" && !hostAvailable(props);
  return (
    <Card className="gap-0 py-0">
      <button
        type="button"
        onClick={() => props.onOpenPage("host")}
        className="flex min-h-11 w-full items-start gap-3 p-4 text-left transition-colors active:bg-muted/60"
      >
        <Server aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="block text-sm font-medium">{hostOptionLabel(props)}</span>
          {broken && (
            <span className="block">
              <StateWord state="broken" word={t("settings.voice.status.broken")} />
            </span>
          )}
          <span className="block pt-0.5">
            <AudioLine reach={option === null ? null : reachOf(option)} text={option === null ? t("settings.voice.audio.unknown") : undefined} />
          </span>
          <span className="block pt-0.5">
            <LastChanged host={props.host} />
          </span>
        </span>
        <ChevronRight aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
      </button>
    </Card>
  );
}

/**
 * Hands-free, with the one extra line it owes when the text it would send unread came back from a
 * service off the host. The warning names the provider, and arrives through `Collapse`.
 */
function HandsFreeCard(props: SpeechCardsProps) {
  const { handsFree, onHandsFree, engine, block } = props;
  const option = hostOptionNow(props);
  const viaHost = phoneChoiceInForce(engine, block) === "host";
  const warn = handsFree && viaHost && (option === "chatgpt" || option === "service");
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Mic className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.handsFree.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.handsFree.description")}</p>
          </div>
        </div>
        <div className="flex h-6 w-11 shrink-0 items-center justify-center">
          <Switch checked={handsFree} onCheckedChange={onHandsFree} aria-label={t("settings.handsFree.ariaLabel")} />
        </div>
      </div>
      <Collapse open={warn}>
        <div className="px-4 pb-4">
          <Notice tone="caution" variant="box" icon={<TriangleAlert />}>
            {t(option === "chatgpt" ? "settings.voice.handsFree.warn.chatgpt" : "settings.voice.handsFree.warn.service")}
          </Notice>
        </div>
      </Collapse>
    </Card>
  );
}

const CHIP_LOOK = {
  gone: { ink: "text-status-blocked", word: "settings.voice.model.chip.gone" },
  update: { ink: "text-status-working", word: "settings.speech.phone.update" },
  downloading: { ink: "text-status-working", word: "settings.voice.copyState.downloading" },
  failed: { ink: "text-status-blocked", word: "settings.voice.copyState.failed" },
  absent: { ink: "text-muted-foreground", word: "settings.voice.copyState.absent" },
  both: { ink: "text-status-done", word: "settings.voice.model.chip.both" },
  host: { ink: "text-status-done", word: "settings.speech.host.heading" },
  phone: { ink: "text-status-done", word: "settings.speech.phone.heading" },
} as const satisfies Record<ModelChip, { ink: string; word: MessageKey }>;

/** The hub's row for the model: who made it, its size, a chip with its state in words, and a way in. */
function ModelHubRow(props: SpeechCardsProps) {
  const chip = CHIP_LOOK[modelChip({ whistle: props.whistle, local: props.local, phoneInForce: phoneChoiceInForce(props.engine, props.block) === "phone" })];
  return (
    <Card className="gap-0 py-0">
      <button
        type="button"
        onClick={() => props.onOpenPage("model")}
        className="flex min-h-11 w-full items-center gap-3 p-4 text-left transition-colors active:bg-muted/60"
      >
        <AudioLines aria-hidden className="size-5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t("settings.voice.model.title")}</span>
          <span className="block text-xs text-muted-foreground">{t("settings.voice.model.by", { size: modelSize(props.whistle, props.local) })}</span>
        </span>
        <Badge variant="outline" className="gap-1 rounded-sm">
          <span aria-hidden className={cn("size-2 rounded-full bg-current", chip.ink)} />
          {t(chip.word)}
        </Badge>
        <ChevronRight aria-hidden className="size-5 shrink-0 text-muted-foreground" />
      </button>
    </Card>
  );
}

function VoiceHub(props: WithAbout) {
  const status = voiceStatus({
    engine: props.engine,
    local: props.local,
    block: props.block,
    provider: currentHostProvider(props.host, props.hostStt),
    available: hostAvailable(props),
    whistle: props.whistle,
    recording: props.recording,
  });
  // Hands-free decides what happens to text a microphone made, so it is shown wherever there is one:
  // a host provider, or this phone's own copy, in a browser that records.
  const handsFreeShown = props.recording && (props.hostStt !== null || (phoneChoiceInForce(props.engine, props.block) === "phone" && Boolean(props.local)));
  return (
    <>
      {!props.canWrite && <ReadOnlyHostBanner />}
      <StatusCard status={status} props={props} />
      <Zone label={t("settings.voice.phone.label")} hint={t("settings.voice.phone.hint")}>
        <PhoneChoices {...props} />
      </Zone>
      <Zone label={t("settings.voice.host.label")} hint={t("settings.voice.host.hint")}>
        <HostSummaryRow {...props} />
        <p className="text-xs text-muted-foreground">{t("settings.voice.host.options")}</p>
      </Zone>
      {handsFreeShown && (
        <Zone label={t("settings.voice.after.label")}>
          <HandsFreeCard {...props} />
        </Zone>
      )}
      {(props.whistle !== null || Boolean(props.local)) && <ModelHubRow {...props} />}
    </>
  );
}

// ── HOST SPEECH ─────────────────────────────────────────────────────────────────────────────────

/** Why a choice is off, and the command that would change that, run on the host. */
function switchWhy(reason: SttHostSwitchReason): { key: MessageKey; command: string | null } | null {
  switch (reason) {
    case "not-ready":
      return { key: "settings.speech.provider.why.notReady", command: null };
    case "codex-missing":
      return { key: "settings.speech.provider.why.codexMissing", command: "codex login" };
    case "codex-signed-out":
      return { key: "settings.speech.provider.why.codexSignedOut", command: "codex login" };
    case "codex-other-login":
      return { key: "settings.speech.provider.why.codexOtherLogin", command: "codex login" };
    case "codex-unknown":
      return { key: "settings.speech.provider.why.codexUnknown", command: "codex login status" };
    case "env":
    case "terminal":
    case "unreadable":
      return null;
  }
}

/** Why nothing at all may be chosen here: the option belongs to a terminal, the environment, or an unreadable file. */
type LockReason = Extract<SttHostSwitchReason, "env" | "terminal" | "unreadable">;

function lockOf(host: SttHostStatus): LockReason | null {
  const reason = host.switchable.off.reason;
  return reason === "env" || reason === "terminal" || reason === "unreadable" ? reason : null;
}

/** An option set up in a terminal, by the environment, or a file that cannot be read: what to run instead of a choice. */
function LockedNote({ lock }: { lock: LockReason }) {
  return (
    <Notice tone="info" variant="box" icon={<Info />}>
      <div className="space-y-2">
        {lock === "terminal" ? (
          <>
            <p>{t("settings.speech.provider.locked.terminal")}</p>
            <HostCommand command="collie stt setup" />
            <p>{t("settings.speech.provider.locked.off")}</p>
            <HostCommand command="collie stt off" />
          </>
        ) : (
          <>
            <p>{t(lock === "env" ? "settings.speech.provider.locked.env" : "settings.speech.provider.locked.unreadable")}</p>
            <HostCommand command="collie stt status" />
          </>
        )}
      </div>
    </Notice>
  );
}

const WHAT_KEYS = {
  whistle: "settings.voice.option.whistle.what",
  command: "settings.voice.option.command.what",
  service: "settings.voice.option.service.what",
  chatgpt: "settings.voice.option.chatgpt.what",
  off: "settings.voice.option.off.what",
} as const satisfies Record<HostOption, MessageKey>;

const CAVEAT_KEYS = {
  command: "settings.voice.option.command.caveat",
  chatgpt: "settings.voice.option.chatgpt.caveat",
} as const satisfies Partial<Record<HostOption, MessageKey>>;

interface RowProps extends WithAbout {
  option: HostOption;
  /** The host's option is this one. */
  inUse: boolean;
  /** This device may choose here: it may write, the host answered, and nothing locks the choice. */
  interactive: boolean;
  /** Drawn with no ring and no action: a device that may not write, or a host that said nothing. */
  readOnlyRow: boolean;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
}

/** One host option's facts: name, what it is, the audio line, and the one thing it cannot promise. */
function OptionFacts({ option, inUse, readOnlyRow }: { option: HostOption; inUse: boolean; readOnlyRow: boolean }) {
  const caveat = option === "command" || option === "chatgpt" ? CAVEAT_KEYS[option] : null;
  return (
    <span className="min-w-0 flex-1 space-y-1">
      <span className="flex items-center gap-2">
        <span className="text-sm font-medium">{optionName(option)}</span>
        {readOnlyRow && inUse && (
          <span className="inline-flex items-center gap-1 text-xs font-medium">
            <Check aria-hidden className="size-3.5" />
            {t("settings.voice.inUse")}
          </span>
        )}
      </span>
      <span className="block text-xs text-muted-foreground">{t(WHAT_KEYS[option])}</span>
      <span className="block pt-1">
        <AudioLine reach={reachOf(option)} />
      </span>
      {caveat !== null && (
        <span className="flex gap-1.5 pt-1 text-xs text-muted-foreground">
          <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{t(caveat)}</span>
        </span>
      )}
    </span>
  );
}

/**
 * One host option. A write device sees a radio for the three the app can switch (Whistle, ChatGPT,
 * Off); the two set up in a terminal open their terminal step instead, and are a radio only while in
 * use. A read-only device sees the same facts with no ring and no action: the one in use carries a
 * check and the words.
 */
function HostOptionRow(props: RowProps) {
  const { option, inUse, interactive, readOnlyRow, host, switching, onChooseProvider, onAbout, terminalOpen, onToggleTerminal } = props;
  const facts = <OptionFacts option={option} inUse={inUse} readOnlyRow={readOnlyRow} />;
  const info = <InfoButton name={optionName(option)} onClick={() => onAbout(option)} />;

  if (readOnlyRow) {
    return (
      <div className="relative">
        <div className="flex items-start gap-3 p-4 pr-14">
          <span className="size-5 shrink-0" aria-hidden />
          {facts}
        </div>
        {info}
        <OptionState {...props} />
      </div>
    );
  }

  const choice = choiceOf(option);
  if (choice === null && !inUse) {
    // Set up in a terminal: the row opens its terminal step. A screen reader hears a disclosure.
    return (
      <div className="relative">
        <button
          type="button"
          aria-expanded={terminalOpen}
          onClick={onToggleTerminal}
          className="flex min-h-11 w-full items-start gap-3 p-4 pr-14 text-left transition-colors active:bg-muted/60"
        >
          <Ring checked={false} />
          <span className="min-w-0 flex-1 space-y-1">
            {facts}
            <span className="flex items-center gap-1 pt-1 text-xs text-muted-foreground">
              {t("settings.voice.terminal.setup")}
              <ChevronDown aria-hidden className={cn("size-4 transition-transform", terminalOpen && "rotate-180")} />
            </span>
          </span>
        </button>
        {info}
        <TerminalStep {...props} />
      </div>
    );
  }

  const sw = choice === null || host === null ? null : host.switchable[choice];
  const disabled = !interactive || choice === null || sw?.ok !== true || switching !== null;
  return (
    <div className="relative">
      <button
        type="button"
        role="radio"
        aria-checked={inUse}
        disabled={disabled && !inUse}
        aria-disabled={inUse && disabled ? true : undefined}
        onClick={() => {
          if (!inUse && choice !== null && !disabled) onChooseProvider(choice);
        }}
        className="flex min-h-11 w-full items-start gap-3 p-4 pr-14 text-left transition-colors active:bg-muted/60 disabled:active:bg-transparent"
      >
        <Ring checked={inUse} busy={choice !== null && switching === choice} />
        <span className={cn("min-w-0 flex-1", disabled && !inUse && "opacity-60")}>{facts}</span>
      </button>
      {info}
      <OptionState {...props} />
    </div>
  );
}

/** What a terminal-only option needs before it can be used: the fixed command, folded. */
function TerminalStep({ option, terminalOpen, checking, onCheckAgain }: RowProps) {
  if (!terminalOnly(option)) return null;
  return (
    <Collapse open={terminalOpen}>
      <div className="pr-4 pb-4 pl-12">
        <TerminalSetup
          command={TERMINAL_COMMANDS[option]}
          note={option === "service" ? t("settings.voice.terminal.keyNote") : undefined}
          checking={checking}
          onCheckAgain={onCheckAgain}
        />
      </div>
    </Collapse>
  );
}

/**
 * What an option needs, or what is wrong with it, under its facts on the text's left edge: the host's
 * own words when the option in use does not work, the reason a choice is closed with the command that
 * opens it, the model's download for Whistle, and the consent note for ChatGPT.
 */
function OptionState(props: RowProps) {
  const { option, inUse, interactive, readOnlyRow, host, whistle, canWrite, hostBusy, onSetup } = props;
  const parts: ReactNode[] = [];
  const choice = choiceOf(option);
  const sw = choice === null || host === null ? null : host.switchable[choice];

  if (inUse && option !== "off" && !hostAvailable(props)) {
    parts.push(
      <div key="broken" className="space-y-1">
        <StateWord state="broken" word={t("settings.voice.status.broken")} />
        <p className="text-xs">{hostReason(props)}</p>
      </div>,
    );
  }
  if (inUse && option === "chatgpt" && host?.identity !== undefined) {
    parts.push(
      <p key="identity" className="text-xs text-muted-foreground">
        <span className="font-mono">{host.identity}</span>{" "}
        {t(host.identity === "codex-cli" ? "settings.speech.provider.identity.codexCli" : "settings.speech.provider.identity.honest")}
      </p>,
    );
  }
  if (inUse && terminalOnly(option) && !readOnlyRow) {
    parts.push(
      <p key="terminal" className="text-xs text-muted-foreground">
        {t("settings.voice.terminal.inUse")}
      </p>,
    );
  }
  // A closed choice, with its reason and the command that opens it. Not for a device that may not
  // write (it cannot act on it) and not under a lock (the note above the list says it once).
  const why = sw !== null && sw.ok === false && sw.reason !== undefined ? switchWhy(sw.reason) : null;
  if (interactive && why !== null) {
    if (option === "whistle" && whistle !== null) {
      parts.push(<WhistleDownload key="whistle" whistle={whistle} canWrite={canWrite} hostBusy={hostBusy} onSetup={onSetup} />);
    } else {
      parts.push(
        <div key="why" className="space-y-2">
          <p className="text-xs text-muted-foreground">{t(why.key)}</p>
          {why.command !== null && <HostCommand command={why.command} />}
        </div>,
      );
    }
  }
  if (interactive && option === "chatgpt" && !inUse && sw?.ok === true) {
    parts.push(
      <p key="consent" className="text-xs text-muted-foreground">
        {t("settings.voice.chatgpt.consentFirst")}
      </p>,
    );
  }
  if (parts.length === 0) return null;
  return <div className="space-y-2 pr-4 pb-4 pl-12">{parts}</div>;
}

/** Whistle's one closed reason, the model not on the host: the download, its bar, or its failure. */
function WhistleDownload({
  whistle,
  canWrite,
  hostBusy,
  onSetup,
}: {
  whistle: WhistleStatus;
  canWrite: boolean;
  hostBusy: boolean;
  onSetup: () => void;
}) {
  if (whistle.state === "downloading") {
    return (
      <div className="space-y-2">
        <p className="text-xs">{t("settings.speech.host.downloading")}</p>
        <Progress received={whistle.received ?? 0} total={whistle.bytes} label={t("settings.speech.progressAria")} />
      </div>
    );
  }
  if (!canWrite) return <p className="text-xs text-muted-foreground">{t("settings.speech.provider.why.notReady")}</p>;
  return (
    <div className="space-y-1">
      {whistle.state === "failed" && <p className="text-xs font-medium">{t("settings.speech.host.failed")}</p>}
      <Button variant="outline" className="h-11" disabled={hostBusy} onClick={onSetup}>
        {hostBusy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
        {t("settings.speech.host.download", { size: formatDownloadSize(whistle.bytes) })}
      </Button>
    </div>
  );
}

/**
 * The five host options in the order audio travels: two tiers, then Off on its own. One bordered card
 * per tier, rows divided by hairlines, so the tier label is the only thing between the two groups.
 */
function HostSpeechPage(props: WithAbout) {
  const { host, hostRead, canWrite, providerError, consentOpen } = props;
  const [terminal, setTerminal] = useState<HostOption | null>(props.initialTerminal ?? null);
  const current = hostOptionNow(props);
  const lock = host === null ? null : lockOf(host);
  // A host that has not said what may be chosen (an older bridge) is drawn like a read-only device,
  // without the banner: nothing here could be sent to it.
  const readOnlyRow = !canWrite || host === null;
  const interactive = !readOnlyRow && lock === null;
  const row = (option: HostOption) => (
    <HostOptionRow
      key={option}
      {...props}
      option={option}
      inUse={current === option}
      interactive={interactive}
      readOnlyRow={readOnlyRow}
      terminalOpen={terminal === option}
      onToggleTerminal={() => setTerminal((open) => (open === option ? null : option))}
    />
  );
  const tier = (which: "stays" | "leaves") => HOST_OPTIONS.filter((o) => tierOf(o) === which).map(row);
  return (
    <>
      {!canWrite && <ReadOnlyHostBanner />}
      <div className="space-y-1">
        <p className="text-sm">{t("settings.voice.hostPage.intro")}</p>
        <LastChanged host={host} />
      </div>
      {!readOnlyRow && lock !== null && <LockedNote lock={lock} />}
      {current === null && (
        <p className="text-xs text-muted-foreground">
          {t("settings.voice.hostPage.other", { provider: currentHostProvider(host, props.hostStt) })}
        </p>
      )}
      {hostRead && (
        <div
          role={readOnlyRow ? undefined : "radiogroup"}
          aria-label={readOnlyRow ? undefined : t("settings.voice.hostPage.group")}
          className="space-y-2"
        >
          <TierLabel>{t("settings.voice.tier.stays")}</TierLabel>
          <Card className="gap-0 divide-y divide-border py-0">{tier("stays")}</Card>
          <TierLabel>{t("settings.voice.tier.leaves")}</TierLabel>
          <Card className="gap-0 divide-y divide-border py-0">{tier("leaves")}</Card>
          <div className="pt-2">
            <Card className="gap-0 py-0">{row("off")}</Card>
          </div>
        </div>
      )}
      {providerError !== null && !consentOpen && (
        <p role="status" className="text-xs text-status-blocked">
          {providerError}
        </p>
      )}
    </>
  );
}

// ── THE TWO SHEETS ──────────────────────────────────────────────────────────────────────────────

/**
 * The host-wide confirm, for a change that sends audio further than before. Before and after, each
 * with its audio line, then the sentence that is the reason this sheet exists.
 */
function HostConfirmSheet(props: SpeechCardsProps) {
  const { confirmTo, onConfirm, onCancelConfirm } = props;
  const before = hostOptionNow(props);
  const after = confirmTo === null ? null : optionOfChoice(confirmTo);
  return (
    <BottomSheet
      open={confirmTo !== null}
      onClose={onCancelConfirm}
      title={after === null ? undefined : t("settings.voice.confirm.title", { option: optionName(after) })}
    >
      {after !== null && (
        <div className="flex flex-col gap-4">
          <p className="text-sm font-medium">{t("settings.voice.confirm.reach")}</p>
          <div className="space-y-3 rounded-sm border border-border p-3">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                {t("settings.voice.confirm.now", { option: before === null ? currentHostProvider(props.host, props.hostStt) : optionName(before) })}
              </p>
              <AudioLine reach={before === null ? null : reachOf(before)} text={before === null ? t("settings.voice.audio.unknown") : undefined} />
            </div>
            <div className="space-y-1 border-t border-border pt-3">
              <p className="text-xs text-muted-foreground">{t("settings.voice.confirm.after", { option: optionName(after) })}</p>
              <AudioLine reach={reachOf(after)} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="h-11 flex-1" onClick={onCancelConfirm}>
              {t("dialog.cancel")}
            </Button>
            <Button type="button" className="h-11 flex-1" onClick={onConfirm}>
              {t("settings.voice.confirm.action")}
            </Button>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}

/**
 * The ChatGPT consent, before anything is sent to the host. The words are `collie stt setup`'s
 * (lib/stt-consent.ts says how they are kept equal), with the host-wide sentence and the audio line
 * above them, and "I accept" is the only control that sends a Codex switch. While the host checks the
 * sign-in and probes the endpoint, the sheet stays open with the button busy, and a refusal is
 * written here, under the words it refused.
 */
export function CodexConsentSheet({
  open,
  codexBin,
  busy,
  error,
  onAccept,
  onCancel,
}: {
  open: boolean;
  /** The binary whose sign-in pays, as the host found it. */
  codexBin: string;
  busy: boolean;
  error: string | null;
  onAccept: () => void;
  onCancel: () => void;
}) {
  useLocale();
  return (
    <BottomSheet open={open} onClose={busy ? () => {} : onCancel} title={t("settings.speech.provider.consent.title")}>
      <div className="flex flex-col gap-3">
        <p className="text-sm font-medium">{t("settings.voice.confirm.reach")}</p>
        <AudioLine reach="chatgpt" />
        {CODEX_CONSENT_KEYS.map((key) => (
          <p key={key} className="text-sm break-words">
            {t(key, { url: CODEX_TRANSCRIBE_URL, codexBin })}
          </p>
        ))}
        {busy && (
          <p role="status" className="text-xs text-muted-foreground">
            {t("settings.speech.provider.consent.probing")}
          </p>
        )}
        {error !== null && !busy && (
          <p role="status" className="text-xs text-status-blocked">
            {error}
          </p>
        )}
        <div className="flex gap-2 pt-1">
          <Button type="button" variant="outline" className="h-11 flex-1" disabled={busy} onClick={onCancel}>
            {t("dialog.cancel")}
          </Button>
          <Button type="button" className="h-11 flex-1" disabled={busy} onClick={onAccept}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t("settings.speech.provider.consent.accept")}
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}

// ── WHISTLE MODEL ───────────────────────────────────────────────────────────────────────────────

/** The credit, always first wherever the model is shown: who made it, its licence, its page. */
function ModelCredit() {
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
    </Card>
  );
}

/** "Details", folded: the checksum and the date, which a person compares rarely. */
function Details({ rows, initial }: { rows: { label: string; value: ReactNode }[]; initial: boolean }) {
  const [open, setOpen] = useState(initial);
  if (rows.length === 0) return null;
  return (
    <div>
      <Button type="button" variant="ghost" className="-ml-2 h-11 px-2 text-xs" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {t("settings.voice.details")}
        <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
      </Button>
      <Collapse open={open}>
        <div className="pb-1">
          <Facts rows={rows} />
        </div>
      </Collapse>
    </div>
  );
}

/** One copy of the model: where it is, its state in a word, then what it needs. */
function CopyCard({
  id,
  where,
  icon: Icon,
  state,
  children,
}: {
  id: string;
  where: string;
  icon: typeof Server;
  state: { look: VoiceStatus["state"]; word: string };
  children: ReactNode;
}) {
  return (
    <Card className="gap-0 py-0">
      <section aria-labelledby={id} className="space-y-2 p-4">
        <h2 id={id} className="flex items-center gap-2">
          <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium">{where}</span>
        </h2>
        <StateWord state={state.look} word={state.word} />
        {children}
      </section>
    </Card>
  );
}

/** A copy's state word and the look it wears. */
interface CopyStateWord {
  look: VoiceStatus["state"];
  word: string;
}

function hostCopyState(whistle: WhistleStatus): CopyStateWord {
  switch (whistle.state) {
    case "ready":
      return { look: "works", word: t("settings.voice.copyState.ready") };
    case "downloading":
      return { look: "setup", word: t("settings.voice.copyState.downloading") };
    case "failed":
      return { look: "broken", word: t("settings.voice.copyState.failed") };
    case "absent":
      return { look: "setup", word: t("settings.voice.copyState.absent") };
  }
}

function HostCopy(props: SpeechCardsProps & { whistle: WhistleStatus }) {
  const { whistle, canWrite, hostError, hostBusy, confirmingRemove, onSetup, onAskRemove, onCancelRemove, onRemove, initialDetails } = props;
  const size = formatDownloadSize(whistle.bytes);
  const hostUsesIt = hostOptionNow(props) === "whistle";
  return (
    <CopyCard id="speech-host-step" where={t("settings.speech.host.heading")} icon={Server} state={hostCopyState(whistle)}>
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
          <p className="text-xs">{t("settings.speech.host.readOnly")}</p>
        ))}
      {whistle.state === "downloading" && (
        <div className="space-y-2">
          <p className="text-xs">{t("settings.speech.host.downloading")}</p>
          <Progress received={whistle.received ?? 0} total={whistle.bytes} label={t("settings.speech.progressAria")} />
        </div>
      )}
      {whistle.state === "failed" && (
        <div className="space-y-2">
          {whistle.reason !== undefined && <p className="text-xs text-muted-foreground">{whistle.reason}</p>}
          {canWrite ? (
            <Button className="h-11" variant="outline" disabled={hostBusy} onClick={onSetup}>
              {hostBusy && <Loader2 className="size-4 animate-spin" />}
              {t("settings.speech.host.retry")}
            </Button>
          ) : (
            <p className="text-xs">{t("settings.speech.host.readOnly")}</p>
          )}
        </div>
      )}
      {whistle.state === "ready" && (
        <>
          <Facts
            rows={[
              { label: t("settings.speech.detail.version"), value: <Version revision={whistle.revision} sha256={whistle.sha256} /> },
              { label: t("settings.speech.detail.size"), value: size },
            ]}
          />
          <Details
            initial={initialDetails === true}
            rows={[
              ...(whistle.sha256 === undefined
                ? []
                : [
                    {
                      label: t("settings.speech.detail.checksum"),
                      // The full value is one hover or long-press away; eight characters is what a person compares.
                      value: (
                        <span className="font-mono" title={whistle.sha256}>
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
          {canWrite && !confirmingRemove && (
            <div className="space-y-1 pt-1">
              <Button variant="outline" className="h-11" onClick={onAskRemove}>
                {t("settings.speech.host.remove")}
              </Button>
              <p className="text-xs text-muted-foreground">
                {t(hostUsesIt ? "settings.voice.model.removeHost.inUse" : "settings.voice.model.removeHost.idle")}
              </p>
            </div>
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
    </CopyCard>
  );
}

function PhoneCopy(props: SpeechCardsProps) {
  const { whistle, block, local, persisted, copy, phoneError, engine, onPhoneDownload, onPhoneRemove } = props;
  const hostReady = whistle?.state === "ready";
  const newer = local !== null && local !== undefined && hostReady && whistle?.sha256 !== undefined && whistle.sha256 !== local.sha256;
  const why = browserBlock(block);
  const size = modelSize(whistle, local);
  const gone = local === null && phoneChoiceInForce(engine, block) === "phone";
  const state: { look: VoiceStatus["state"]; word: string } = local
    ? newer
      ? { look: "setup", word: t("settings.voice.copyState.older") }
      : { look: "works", word: t("settings.voice.copyState.ready") }
    : gone
      ? { look: "paused", word: t("settings.voice.copyState.gone") }
      : { look: "setup", word: t("settings.voice.copyState.notSetUp") };
  return (
    <CopyCard id="speech-phone-step" where={t("settings.speech.phone.heading")} icon={Smartphone} state={state}>
      {copy !== null ? (
        <div className="space-y-2">
          <p className="text-xs">{t("settings.speech.phone.copying")}</p>
          <Progress received={copy.received} total={copy.total} label={t("settings.speech.progressAria")} />
        </div>
      ) : local ? (
        <>
          <Facts
            rows={[
              { label: t("settings.speech.detail.version"), value: <Version revision={local.revision} sha256={local.sha256} /> },
              { label: t("settings.speech.detail.size"), value: formatDownloadSize(local.bytes) },
            ]}
          />
          <p className="text-xs text-muted-foreground">{persisted ? t("settings.speech.phone.kept") : t("settings.speech.phone.mayClear")}</p>
          {newer && (
            <div className="flex min-h-11 items-center justify-between gap-3">
              <span className="min-w-0 text-xs">{t("settings.speech.phone.newer")}</span>
              <Button className="h-11 shrink-0" disabled={why !== null} onClick={onPhoneDownload}>
                {t("settings.speech.phone.update")}
              </Button>
            </div>
          )}
          <div className="space-y-1 pt-1">
            <Button variant="outline" className="h-11" onClick={onPhoneRemove}>
              {t("settings.speech.phone.remove")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {phoneChoiceInForce(engine, block) === "phone"
                ? t("settings.voice.model.removePhone.inUse")
                : t("settings.voice.model.removePhone.idle", { size })}
            </p>
          </div>
        </>
      ) : why !== null ? (
        // This browser cannot run the engine, so a button would only lead to a dead end.
        <p className="text-xs">{t(BLOCK_KEYS[why])}</p>
      ) : hostReady ? (
        <Button variant={gone ? "default" : "outline"} className="h-11" disabled={local === undefined} onClick={onPhoneDownload}>
          <Download className="size-4" />
          {t(gone ? "settings.voice.restore" : "settings.voice.copy.toPhone", { size })}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">{t("settings.voice.model.phoneNeedsHost")}</p>
      )}
      {phoneError !== null && (
        <p role="status" className="text-xs text-status-blocked">
          {phoneError}
        </p>
      )}
    </CopyCard>
  );
}

function WhistleModelPage(props: SpeechCardsProps) {
  return (
    <>
      {!props.canWrite && <ReadOnlyHostBanner />}
      <ModelCredit />
      {props.whistle !== null && <HostCopy {...props} whistle={props.whistle} />}
      <PhoneCopy {...props} />
    </>
  );
}

// ── THE CONTROLLER ──────────────────────────────────────────────────────────────────────────────

/** How often the host is asked while its download runs. Only while the page is on screen. */
export const WHISTLE_POLL_MS = 1000;
/** Failed polls in a row after which the polling stops, so a host that went away is not asked forever. */
const POLL_FAILURE_LIMIT = 10;

/**
 * The Voice pages, wired. Write access is read the way the dashboard reads it: the bridge's device
 * gate (`isReadOnly`, from the root loader) or a refused pairing, either of which makes this device
 * read-only. Nothing here decides it by itself, and the bridge still enforces it on every write.
 */
export function SpeechControl({ page = "hub" }: { page?: VoiceView }) {
  useLocale();
  const nav = useNav();
  const scope = useScope();
  const root = useOptionalRootData();
  const { refused } = usePairing();
  const canWrite = !isReadOnly(root?.device) && !refused;
  const whistle = useWhistleStatus();
  const hostStt = useHostSttCapability();
  const configRead = useOperatorConfigRead();
  const engine = useSttEnginePreference();
  const probe = useSttProbeState();
  const handsFree = useHandsFree();
  const { model: local, persisted } = useStoredModel();

  const [copy, setCopy] = useState<PhoneCopy>(null);
  const [hostError, setHostError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [hostBusy, setHostBusy] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const copyAbort = useRef<AbortController | null>(null);
  const [host, setHost] = useState<SttHostStatus | null>(null);
  const [hostRead, setHostRead] = useState(false);
  const [checking, setChecking] = useState(false);
  const [switching, setSwitching] = useState<SttHostChoice | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [confirmTo, setConfirmTo] = useState<SttHostChoice | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  // "Set up" on the hub: once the host's download is ready, this phone copies it.
  const copyWhenReady = useRef(false);

  // THE HOST'S OPTION, read when the page opens and again whenever the model changes state, because
  // a ready model is what opens the Whistle row and a removed one may take the option with it. An
  // older bridge answers 404 and the host is drawn from the config alone; nothing here retries.
  const modelKey = `${whistle?.state ?? "none"}:${whistle?.sha256 ?? ""}:${whistle?.hostEngine === true}`;
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setHost(await fetchSttHost(controller.signal));
      } catch {
        if (controller.signal.aborted) return;
      }
      setHostRead(true);
    })();
    return () => controller.abort();
  }, [modelKey]);

  const block = phoneEngineBlock({
    env: phoneEngineEnv(),
    probe,
    haveLocalModel: local !== null,
    hostReady: whistle?.state === "ready",
  });

  // Ask the worker once whether this browser runs the engine, as soon as there is a model to run and
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
      // The host's option may have changed with it, and the microphone follows the option.
      if (refresh) void refreshOperatorConfig();
    } catch (error) {
      copyWhenReady.current = false;
      const message = describeThrownError(error);
      setHostError(message);
      if (page === "hub") setPhoneError(message);
    } finally {
      setHostBusy(false);
      setConfirmingRemove(false);
    }
  }

  /** Read the host's option once more, after a step in its terminal. */
  async function checkAgain(): Promise<void> {
    setChecking(true);
    try {
      setHost(await fetchSttHost());
      void refreshOperatorConfig();
    } catch (error) {
      setProviderError(describeThrownError(error));
    } finally {
      setChecking(false);
    }
  }

  /**
   * Send one choice to the host. ChatGPT only ever arrives here from "I accept", with the id of the
   * consent text the sheet showed; Whistle and Off arrive on the tap or from the confirm. The answer
   * is the host's new status, and the config is re-read with it, because the microphone follows it.
   */
  async function switchProvider(choice: SttHostChoice): Promise<void> {
    setSwitching(choice);
    setProviderError(null);
    setConsentError(null);
    try {
      setHost(await setSttHost(choice, choice === "codex" ? CODEX_CONSENT_ID : undefined));
      setConsentOpen(false);
      void refreshOperatorConfig();
    } catch (error) {
      if (choice === "codex") setConsentError(describeThrownError(error));
      else setProviderError(describeThrownError(error));
      // What the host says now, so a row that closed meanwhile shows why.
      fetchSttHost().then(setHost, () => undefined);
    } finally {
      setSwitching(null);
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

  // "Set up" asked for both steps: the copy follows the host's download, once, when it is ready.
  const hostReady = whistle?.state === "ready";
  const hostFailed = whistle?.state === "failed";
  useEffect(() => {
    if (!copyWhenReady.current) return;
    if (hostFailed) copyWhenReady.current = false;
    if (!hostReady || copy !== null) return;
    copyWhenReady.current = false;
    void phoneDownload();
    // `phoneDownload` reads the latest status itself; this runs on the host's answer only.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [hostReady, hostFailed]);

  const props: SpeechCardsProps = {
    page,
    whistle,
    hostStt,
    host,
    hostRead,
    switching,
    providerError,
    confirmTo,
    consentOpen,
    consentError,
    canWrite,
    recording: sttRecordingSupported(),
    engine,
    block,
    local,
    persisted,
    copy,
    hostError,
    phoneError,
    hostBusy,
    checking,
    confirmingRemove,
    handsFree,
    onEngine: setSttEnginePreference,
    onHandsFree: setHandsFreeEnabled,
    onSetup: () => void hostAction(startWhistleSetup),
    onSetupBoth: () => {
      copyWhenReady.current = true;
      setPhoneError(null);
      void hostAction(startWhistleSetup);
    },
    onAskRemove: () => setConfirmingRemove(true),
    onCancelRemove: () => setConfirmingRemove(false),
    onRemove: () => void hostAction(removeWhistleModel, true),
    onChooseProvider: (choice) => {
      setProviderError(null);
      const ask = askFor(hostOptionOf(currentHostProvider(host, hostStt)), choice);
      if (ask === "consent") {
        // Nothing is sent before "I accept".
        setConsentError(null);
        setConsentOpen(true);
      } else if (ask === "confirm") {
        setConfirmTo(choice);
      } else {
        void switchProvider(choice);
      }
    },
    onConfirm: () => {
      const choice = confirmTo;
      setConfirmTo(null);
      if (choice !== null) void switchProvider(choice);
    },
    onCancelConfirm: () => setConfirmTo(null),
    onAcceptConsent: () => void switchProvider("codex"),
    onCancelConsent: () => setConsentOpen(false),
    onPhoneDownload: () => void phoneDownload(),
    onPhoneRemove: () => {
      setPhoneError(null);
      void removeModel();
    },
    onCheckAgain: () => void checkAgain(),
    onOpenPage: (to) => nav.down(voicePagePath(to, scope)),
  };

  if (page === "hub") {
    // The index always offers Voice, so a page with nothing to show says why, once the host has
    // answered both reads and this phone has looked for its own copy.
    if (!voiceHubShown(props)) return configRead && hostRead && local === null ? <VoiceEmpty /> : null;
  }
  return <SpeechCards {...props} />;
}
