// Settings section of the states playground. Split out of app.tsx; see that file's header comment
// for the whole page's rules.

import { useState } from "react";

import { LauncherHowSheet } from "@/components/launcher-how-sheet";
import { CommandPicker } from "@/components/new-command-picker";
import { NoPromptsSheet } from "@/components/no-prompts-sheet";
import { NotifyPrefsCard } from "@/components/notify-prefs-control";
import { SpaceOverview } from "@/components/space-overview";
import { CodexConsentSheet, SpeechCards, type SpeechCardsProps } from "@/components/speech-control";
import { commandChoice, commandKey, commandOptions, offerFor, pickOfKey } from "@/lib/new-page";
import type { LauncherItem, RecentRun, SttCapability, SttHostStatus, WhistleStatus } from "@/lib/types";
import {
  devicesPaired,
  devicesUnpaired,
  homeCrew,
  homeSolo,
  spacesWithWorktrees,
  watchedPanes,
} from "../fixtures";
import { NewRouter, SettingsRouter } from "../harness";
import { Card, Group, Section, Stage, type SectionDef } from "../layout";
import { PhoneFrameCard } from "./shared";

export const DEF: SectionDef = {
  id: "settings",
  title: "Settings",
  intent:
    "The whole settings route, mounted twice: once on a solo collie with nothing paired, once on a lead with three paired devices and a crew card to show for it. Then the Updates page it links to, which is where the check, the card, the peers and the one button now live.",
};

// ── The Shell half of the New page, with one-off commands (ADR 0095) ───────────────────────────────

/** What a 1.19.0 bridge lists under Shell: the shell and one operator row. */
const RUN_ITEMS: LauncherItem[] = [
  { key: "shell", start: { shell: true }, group: "commands", label: "Shell", source: "builtin", noPrompts: false, branch: true, available: true },
  {
    key: "row:make test",
    start: { command: "make test" },
    group: "commands",
    label: "make test",
    command: "make test",
    source: "operator",
    noPrompts: false,
    branch: false,
    available: true,
  },
];

/** The machine's history: a plain line, a line that skips prompts, and a line too long for its option. */
const RUN_RECENT: RecentRun[] = [
  { line: "make deploy --env staging", cwd: "/home/op/app", at: 3, noPrompts: false, available: true },
  { line: "codex --dangerously-bypass-approvals-and-sandbox", cwd: null, at: 2, noPrompts: true, available: true },
  { line: "journalctl --user -u collie.service --since today --no-pager", cwd: null, at: 1, noPrompts: false, available: true },
];

/** A history entry as a bridge lists it while `[phone] run` is off. */
function runOff(entry: RecentRun): RecentRun {
  return { line: entry.line, cwd: entry.cwd, at: entry.at, noPrompts: entry.noPrompts, available: false, reason: "run_off" };
}

/**
 * The real Command select and what hangs off it, fed by the real rules (`offerFor`, `commandOptions`),
 * with the choice and the typed line held here. The page's Start, the check and the history writes are
 * not wired: a card writes nothing.
 */
function CommandPickerDemo({ run, pick, line = "" }: { run: boolean; pick: string; line?: string }) {
  const [key, setKey] = useState(pick);
  const [typed, setTyped] = useState(line);
  const recentRuns = RUN_RECENT.map((e) => (run ? e : runOff(e)));
  const offer = offerFor({ harnesses: [], items: RUN_ITEMS, loaded: true, rows: [], canWorktree: true, run, recentRuns });
  const command = commandChoice(offer, pickOfKey(offer, key), null);
  return (
    <div className="p-4">
      <CommandPicker
        options={commandOptions(offer, "Just a shell")}
        value={commandKey(command)}
        onChoose={setKey}
        typed={command.kind === "typed" ? { line: typed, onLine: setTyped, onGo: () => {} } : null}
        recent={command.kind === "run" ? { busy: false, onRemove: () => {}, onClear: () => {} } : null}
      />
    </div>
  );
}

// ── Settings → Voice (ADR 0096, ADR 0097) ───────────────────────────────────────────────────────────

const WHISTLE_BYTES = 16_919_407;
const WHISTLE_SHA = "b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb";
const WHISTLE_REVISION = "ca5287601bef25af26dcf2e1b2bdc0843a7c19e5";
const WHISTLE_ABSENT: WhistleStatus = { state: "absent", bytes: WHISTLE_BYTES, hostEngine: false, hostTaken: false };
const WHISTLE_READY: WhistleStatus = {
  ...WHISTLE_ABSENT,
  state: "ready",
  sha256: WHISTLE_SHA,
  revision: WHISTLE_REVISION,
  fetchedAt: "2026-10-11T09:30:00.000Z",
};
/** The host runs Whistle: its provider is on and answers. */
const HOST_WHISTLE: SttCapability = { provider: "whistle", available: true, input: "wav-16k", maxDurationMs: 240_000 };
/** A copy on the phone, of the model the host holds. */
const PHONE_COPY = { sha256: WHISTLE_SHA, bytes: WHISTLE_BYTES, revision: WHISTLE_REVISION };

/** Where the host's `codex` lives in these cards. */
const CODEX_BIN = "/home/op/.local/bin/codex";
const OPEN_ALL: SttHostStatus["switchable"] = { whistle: { ok: true }, codex: { ok: true }, off: { ok: true } };
/** No provider on the host; Whistle not downloaded yet; Codex installed and signed in. */
const PROVIDER_NONE: SttHostStatus = {
  provider: "none",
  available: false,
  configuredBy: "none",
  codexBin: CODEX_BIN,
  switchable: { ...OPEN_ALL, whistle: { ok: false, reason: "not-ready" } },
};
/** No provider, the model is ready: all three choices open. */
const PROVIDER_NONE_READY: SttHostStatus = { ...PROVIDER_NONE, switchable: OPEN_ALL };
const PROVIDER_WHISTLE: SttHostStatus = { ...PROVIDER_NONE_READY, provider: "whistle", available: true, configuredBy: "file" };
const PROVIDER_CODEX: SttHostStatus = { ...PROVIDER_WHISTLE, provider: "codex", identity: "honest" };
const TERMINAL_LOCK: SttHostStatus["switchable"] = {
  whistle: { ok: false, reason: "terminal" },
  codex: { ok: false, reason: "terminal" },
  off: { ok: false, reason: "terminal" },
};

/** The Voice page's cards with every fact handed in, as the real control hands them. Taps do nothing. */
function SpeechDemo(over: Partial<SpeechCardsProps>) {
  return (
    <div className="space-y-4 p-4">
      <SpeechCards
        whistle={WHISTLE_ABSENT}
        hostStt={null}
        host={PROVIDER_NONE}
        switching={null}
        providerError={null}
        consentOpen={false}
        consentError={null}
        canWrite
        engine="host"
        block={null}
        local={null}
        persisted={false}
        copy={null}
        hostError={null}
        phoneError={null}
        hostBusy={false}
        confirmingRemove={false}
        onEngine={() => {}}
        onSetup={() => {}}
        onAskRemove={() => {}}
        onCancelRemove={() => {}}
        onRemove={() => {}}
        onChooseProvider={() => {}}
        onAcceptConsent={() => {}}
        onCancelConsent={() => {}}
        onPhoneDownload={() => {}}
        onPhoneRemove={() => {}}
        {...over}
      />
    </div>
  );
}

export function SettingsSection() {
  return (
    <Section def={DEF}>
      <Group title="Settings">
        <Card
          state="settings-solo-unpaired"
          label="settings, solo collie, nothing paired"
          reach="tap the gear from the dashboard. With no device paired, the bridge answers no read and no write, and the Paired devices card offers the pairing verb instead of a list."
          note="The whole real route. Two things on it still reach the network on purpose — /api/config for the diagnostics build, and the browser's own push subscription — and both fail soft, so the page renders whole with no bridge."
          span={2}
        >
          <PhoneFrameCard height={760}>
            <SettingsRouter home={homeSolo} devices={devicesUnpaired} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="settings-lead-paired"
          label="settings, lead of a crew, three devices paired"
          reach="pair a phone with `collie pair`, then open Settings on the lead. The Crew card appears only on a multi-machine roster; the device list names which row is the phone you are holding."
          note="One Updates row, where three update cards used to stand. Its status line follows the footer chip's old precedence and its chevron says it opens a page."
          span={2}
        >
          <PhoneFrameCard height={760}>
            <SettingsRouter home={homeCrew} devices={devicesPaired} />
          </PhoneFrameCard>
        </Card>
      </Group>

      <Group title="Voice">
        <Card
          state="voice-nothing-installed"
          label="1: nothing installed"
          reach="open Settings, Voice, on a lead whose host has no Whistle model yet. The Download to host button is for a device with write access."
          note="Both choices under Speech engine are off, and the reason for This phone is written once, under the choice. The phone step is not drawn: there is nothing yet to copy. Under Host speech provider, Whistle is off until the model is on the host."
        >
          <Stage height={1300}>
            <SpeechDemo block="host-not-ready" />
          </Stage>
        </Card>

        <Card
          state="voice-host-downloading"
          label="2: the host is downloading"
          reach="tap Download to host. The bar follows the host's own count, asked once a second while this page is open, and ends when the host says ready or failed."
          note="There is no cancel in 1.20.0: the host finishes or fails on its own."
        >
          <Stage height={1200}>
            <SpeechDemo whistle={{ ...WHISTLE_ABSENT, state: "downloading", received: 7_400_000 }} block="host-not-ready" />
          </Stage>
        </Card>

        <Card
          state="voice-host-ready"
          label="3: ready on the host, phone not set up"
          reach="after the host's download finishes. The details name the model, its version on Hugging Face, its size, a short checksum and when the host fetched it."
          note="Whistle is now open under Host speech provider, the host-wide choice. The host has no provider yet, so Host under Speech engine is off with its reason. Set up on this phone is the next step."
        >
          <Stage height={1560}>
            <SpeechDemo whistle={WHISTLE_READY} host={PROVIDER_NONE_READY} />
          </Stage>
        </Card>

        <Card
          state="voice-phone-copying"
          label="4: the phone is copying"
          reach="tap Set up on this phone. The bar takes the place of the button; the copy is checked against the host's hash before it is kept."
          note="Leaving the page ends a copy in progress, and nothing is kept from a half-finished one."
        >
          <Stage height={1560}>
            <SpeechDemo whistle={WHISTLE_READY} host={PROVIDER_NONE_READY} copy={{ received: 7_400_000, total: WHISTLE_BYTES }} />
          </Stage>
        </Card>

        <Card
          state="voice-both-ready"
          label="5: both ready, engine on This phone"
          reach="after the copy finishes, choose This phone under Speech engine."
          note="Shown with Whistle chosen as the host's provider, so the line under the choice says the host uses Whistle too. The version on the phone is the same short hash as on the host."
        >
          <Stage height={1560}>
            <SpeechDemo
              whistle={{ ...WHISTLE_READY, hostEngine: true }}
              hostStt={HOST_WHISTLE}
              host={PROVIDER_WHISTLE}
              engine="phone"
              local={PHONE_COPY}
              persisted
            />
          </Stage>
        </Card>

        <Card
          state="voice-newer-on-host"
          label="6: a newer model on the host"
          reach="when the host's model changes after this phone copied it. The phone's version differs from the host's."
          note="The phone keeps working with its own copy. Update copies the new one over it."
        >
          <Stage height={1560}>
            <SpeechDemo
              whistle={{ ...WHISTLE_READY, hostEngine: true }}
              hostStt={HOST_WHISTLE}
              host={PROVIDER_WHISTLE}
              engine="phone"
              local={{ sha256: "a".repeat(64), bytes: WHISTLE_BYTES, revision: "1f0e2d3c4b5a69788796a5b4c3d2e1f001122334" }}
              persisted={false}
            />
          </Stage>
        </Card>

        <Card
          state="voice-browser-cannot"
          label="7: this browser cannot run the engine"
          reach="open Settings, Voice, over plain HTTP on a phone. The same card appears when the browser has no WebAssembly, or when it blocks the engine."
          note="The reason stands where the Set up on this phone button would be, and is not repeated under the choice. Host can still be chosen when the host has a provider."
        >
          <Stage height={1560}>
            <SpeechDemo whistle={{ ...WHISTLE_READY, hostEngine: true }} hostStt={HOST_WHISTLE} host={PROVIDER_WHISTLE} block="insecure" />
          </Stage>
        </Card>

        <Card
          state="voice-read-only"
          label="8: a read-only device"
          reach="open Settings, Voice, on a device that may not write. Downloading to the host is a write; copying to the phone is a read."
          note="One sentence stands where the button would be. Once the host is ready, the same device sees the details and no Remove button. The Host speech provider card shows the status and no choice."
        >
          <Stage height={980}>
            <SpeechDemo canWrite={false} block="host-not-ready" />
          </Stage>
        </Card>
      </Group>

      <Group title="Voice: Host speech provider">
        <Card
          state="voice-provider-none"
          label="9: Host speech provider, nothing set up"
          reach="open Settings, Voice, on a host with no speech provider, the model already downloaded and Codex signed in."
          note="Off is chosen. Whistle and Codex are both open. Set up elsewhere names the one command for a key or a command, to copy and run on the host; there is no form."
        >
          <Stage height={620}>
            <SpeechDemo whistle={null} host={PROVIDER_NONE_READY} />
          </Stage>
        </Card>

        <Card
          state="voice-provider-whistle"
          label="10: Host speech provider, Whistle on"
          reach="choose Whistle under Host speech provider. One tap: Whistle carries no key, no command and no audio off the host."
          note="The status line says Working. Off and Codex stay open."
        >
          <Stage height={620}>
            <SpeechDemo whistle={null} host={PROVIDER_WHISTLE} />
          </Stage>
        </Card>

        <Card
          state="voice-provider-codex-honest"
          label="11: Host speech provider, Codex on, honest identity"
          reach="choose Codex and tap I accept; the endpoint took Collie under its own name."
          note="The Identity row shows the recorded word, honest, and what it means."
        >
          <Stage height={680}>
            <SpeechDemo whistle={null} host={PROVIDER_CODEX} />
          </Stage>
        </Card>

        <Card
          state="voice-provider-codex-fallback"
          label="12: Host speech provider, Codex on, fallback identity"
          reach="as 11, when the endpoint refused Collie's own name and accepted only the Codex CLI's headers."
          note="The word codex-cli is shown as recorded, with what it means in plain words. Off ends it."
        >
          <Stage height={700}>
            <SpeechDemo whistle={null} host={{ ...PROVIDER_CODEX, identity: "codex-cli" }} />
          </Stage>
        </Card>

        <Card
          state="voice-provider-terminal"
          label="13: Host speech provider, an endpoint set up in a terminal"
          reach="a host where the operator ran collie stt setup --provider openai-compatible, with a key."
          note="Shown, never changed here. No choice is drawn; the commands that change it or turn it off are there to copy and run on the host."
        >
          <Stage height={560}>
            <SpeechDemo whistle={null} host={{ provider: "openai-compatible", available: true, configuredBy: "file", switchable: TERMINAL_LOCK }} />
          </Stage>
        </Card>

        <Card
          state="voice-provider-codex-signed-out"
          label="14: Host speech provider, Codex not signed in"
          reach="a host where codex is installed but codex login status says Not logged in."
          note="Codex is off, with the reason and codex login to copy. Whistle waits for the model here."
        >
          <Stage height={680}>
            <SpeechDemo
              whistle={null}
              host={{ ...PROVIDER_NONE, switchable: { ...PROVIDER_NONE.switchable, codex: { ok: false, reason: "codex-signed-out" } } }}
            />
          </Stage>
        </Card>

        <Card
          state="voice-provider-read-only"
          label="15: Host speech provider, a read-only device"
          reach="open Settings, Voice, on a device without the write grant."
          note="The status and the identity only. One sentence where the choice would be."
        >
          <Stage height={460}>
            <SpeechDemo whistle={null} host={PROVIDER_CODEX} canWrite={false} />
          </Stage>
        </Card>

        <Card
          state="voice-provider-consent"
          label="16: Use Codex for speech?, the consent sheet"
          reach="tap Codex under Host speech provider. Nothing is sent to the host before I accept."
          note="The words are the ones collie stt setup prints, kept equal by a test. I accept sends the consent's id with the switch; the host then checks the sign-in and probes the endpoint, honest name first."
        >
          <Stage height={720}>
            <CodexConsentSheet open codexBin={CODEX_BIN} busy={false} error={null} onAccept={() => {}} onCancel={() => {}} />
          </Stage>
        </Card>
      </Group>

      <Group title="Notify when">
        <Card
          state="settings-notify-cache-row"
          label="notify card, the fourth switch and the panes watched one by one"
          reach="scroll to Notify when in Settings. The fifth row is the cache warning, off by default,
            and the section under it names the panes switched on one at a time from their own sheets —
            which is what makes the global-OR-per-pane rule visible instead of implicit."
          note="The real card with a fixture: the playground answers no API, so the controller's two
            fetches are replaced by handed-in values rather than stubbed."
        >
          <Stage height={420}>
            <div className="p-4">
              <NotifyPrefsCard
                prefs={{ blocked: true, done: false, updates: true, cache: false, machines: true }}
                busy={false}
                onToggle={() => {}}
                entries={watchedPanes}
                entriesBusy={false}
                onForget={() => {}}
              />
            </div>
          </Stage>
        </Card>
      </Group>

      <Group title="Updates">
        <Card
          state="updates-page"
          label="updates, the page the Settings row opens"
          reach="tap the Updates row in Settings. The check control on top, then one card carrying the version, the preflight, the run progress, a read-only line per peer, and the single action button."
          note="No bridge here, so the card's own read of /api/update/check never lands: the versions come from the snapshot and the peer lines stay empty. Against a live lead the same card grows one line per member, worst first."
          span={2}
        >
          <PhoneFrameCard height={760}>
            <SettingsRouter home={homeCrew} devices={devicesPaired} start="/settings/updates" />
          </PhoneFrameCard>
        </Card>
      </Group>

      <Group title="Spaces">
        <Card
          state="spaces-repo-worktrees"
          label="spaces, a repo and its worktrees"
          reach="open a worktree of a repo you already have open as a space. Herdr reports the repo on both, so the list nests the worktree under the checkout showing that repo — no extra call, and nothing to switch on."
          note="`blog` sits outside any repo and stays flat, which is the same row it always was. A worktree whose repo is NOT open would also stay flat: there would be nothing to indent under."
          span={2}
        >
          <PhoneFrameCard height={430}>
            <SpaceOverview
              workspaces={spacesWithWorktrees}
              // No agents: this card is about SHAPE. With a herd attached every row also carries its
              // triage tint, and a wall of "needs you" red says nothing about nesting.
              agents={[]}
              onOpen={() => {}}
              onNewSpace={() => {}}
              open
              onOpenChange={() => {}}
            />
          </PhoneFrameCard>
        </Card>

        <Card
          state="new-page"
          label="the New page"
          reach="tap + New on the dashboard, the folder button on the Spaces list, or the empty dashboard's first-agent card. A pane's ⋯ New agent in a worktree opens it with the worktree switch on."
          note="The agents and the commands are the chosen machine's own answer (GET /api/launchers), so this card shows what the bridge behind the playground reports. What cannot run there stays in its list, disabled, with its reason in brackets. Start is pinned to the foot."
          span={2}
        >
          <PhoneFrameCard height={640}>
            <NewRouter home={homeSolo} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="new-page-pick-host"
          label="New page, crew, pick a machine"
          reach="open the New page on a lead with peers. On a solo collie the machine select is not rendered at all."
          note="The select is on the machine the start lands on: the one the list was already showing (?machine=workshop here), or the lead. A machine that cannot take writes stays in the list, disabled, with a word for why in brackets."
          span={2}
        >
          <PhoneFrameCard height={640}>
            <NewRouter home={homeCrew} start="/new?machine=workshop" />
          </PhoneFrameCard>
        </Card>

        <Card
          state="new-page-run-typed"
          label="New page, Shell, Type a command"
          reach="on the New page, switch to Shell and pick Type a command… in the Command select. It shows when the machine's launchers.toml leaves [phone] run on, which is the default."
          note="One monospace field right under the select, with the corrections of the keyboard turned off and Go on the return key. The row is reserved only while the option is chosen, so picking it is a choice and typing moves nothing. On the real page the summary above Start reads Runs `htop` in ~/projects on bluefin, and Start checks the line first, so a line that skips permission prompts asks before its first run."
        >
          <Stage height={240}>
            <CommandPickerDemo run pick="typed" line="htop" />
          </Stage>
        </Card>

        <Card
          state="new-page-run-recent"
          label="New page, Shell, a Recent entry chosen"
          reach="on the New page, switch to Shell and pick a line from the Recent group, which lists the one-off lines run on that machine, newest first. Starting it runs that line again."
          note="The option shows the line, cut when long, with (No prompts) where it applies. A small Remove from history and Clear history sit under the select while an entry is chosen; Clear history asks first, in a sheet. Picking an entry fills the folder with the one it last ran in, unless you changed the folder on this visit. The card writes nothing."
        >
          <Stage height={380}>
            <CommandPickerDemo run pick="run:make deploy --env staging" />
          </Stage>
        </Card>

        <Card
          state="new-page-run-off"
          label="New page, Shell, one-off commands turned off"
          reach="on the New page, switch to Shell on a machine whose launchers.toml sets [phone] run = false."
          note="The history stays in the list, each line disabled with its reason in brackets, and Type a command… is gone."
        >
          <Stage height={120}>
            <CommandPickerDemo run={false} pick="shell" />
          </Stage>
        </Card>

        <Card
          state="new-page-add"
          label="Add your own, Agent, a recipe"
          reach="on the New page, tap Add your own under the Agent select. It shows when the machine's launchers.toml lets a phone add."
          note="Pick the harness, tap the option chips (one per group), read the line Collie will type, and tap Add. The list below is every row a phone added on that machine, with Rename and Remove, and the operator's own rows locked. The recipes and rows are the chosen machine's own answer, so this card shows what the bridge behind the playground reports."
          span={2}
        >
          <PhoneFrameCard height={760}>
            <NewRouter home={homeSolo} start="/new/add?kind=agent" />
          </PhoneFrameCard>
        </Card>

        <Card
          state="new-page-add-command"
          label="Add your own, Command, a typed line"
          reach="on the New page, switch to Shell and tap Add your own under the Command select. Agent has the same way under Write a command."
          note="A typed line is off until the operator sets [phone] free_text = true; then the card shows one disabled row saying so. Check the line shows every hidden character as its code before Add turns on."
          span={2}
        >
          <PhoneFrameCard height={760}>
            <NewRouter home={homeSolo} start="/new/add?kind=command" />
          </PhoneFrameCard>
        </Card>

        <Card
          state="new-page-add-how"
          label="How adding works, the explainer sheet"
          reach="on the Add your own page, tap How adding works."
          note="The recipe, Write a command and how the operator turns it on, this machine's launchers.toml path with one example row and a Copy button, where phone rows live, and the docs link."
        >
          <Stage height={640}>
            <LauncherHowSheet open onClose={() => {}} file="/home/op/.config/collie/launchers.toml" />
          </Stage>
        </Card>

        <Card
          state="new-page-no-prompts-confirm"
          label="Start without prompts?, the confirm sheet"
          reach="on the New page, tap Start on a launcher with the No prompts badge for the first time on this phone and machine. The dashboard's Launch strip and the switcher's Launch section ask the same question."
          note="Asked once per phone, machine and line. Cancel does nothing; Start remembers the answer and goes on."
        >
          <Stage height={520}>
            <NoPromptsSheet
              ask={{ command: "claude --dangerously-skip-permissions", folder: "~/projects/collie", machine: "workshop" }}
              onStart={() => {}}
              onCancel={() => {}}
            />
          </Stage>
        </Card>
      </Group>
    </Section>
  );
}
