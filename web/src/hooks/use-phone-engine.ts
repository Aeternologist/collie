import { useEffect } from "react";

import { useStoredModel } from "@/hooks/use-stored-model";
import {
  phoneEngineBlock,
  phoneEngineEnv,
  runSttProbe,
  sttRecordingSupported,
  useSttEnginePreference,
  useSttProbeState,
} from "@/lib/stt";

/**
 * Whether "This phone" will transcribe the next clip (ADR 0096 Decision 1): the device asked for it,
 * this phone holds a model, the browser passed the worker's probe, and this browser can record.
 *
 * A probe that has not answered yet counts as passed, the way Settings reads it, so the microphone does
 * not flash away and back. The first dictation (or the probe this hook starts) settles it, and a probe
 * that says no takes the phone engine away with the sentence Settings already has for it.
 *
 * Cheap on a host-engine device: it reads one preference and never starts a worker.
 */
export function usePhoneEngineUsable(): boolean {
  const preference = useSttEnginePreference();
  const probe = useSttProbeState();
  const { model } = useStoredModel();
  const wanted = preference === "phone" && model !== null && model !== undefined;
  useEffect(() => {
    if (wanted && probe === "unknown") void runSttProbe();
  }, [wanted, probe]);
  if (!wanted || !sttRecordingSupported()) return false;
  return phoneEngineBlock({ env: phoneEngineEnv(), probe, haveLocalModel: true, hostReady: false }) === null;
}
