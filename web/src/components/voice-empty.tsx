import { Mic } from "lucide-react";

import { Card } from "@/components/ui/card";
import { useStoredModel } from "@/hooks/use-stored-model";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { useOperatorConfigRead, useSttCapability, useWhistleStatus } from "@/lib/stt";

/**
 * What Settings → Voice says when it has nothing to show. The index always offers the Voice row (a
 * row that comes and goes teaches nobody where to look), so the page owes an answer to "why is it
 * empty": this host offers no Whistle, this phone holds no model, and this browser has no speech
 * provider it can record for (none is configured, or it cannot record), so neither the Whistle
 * cards nor the hands-free switch has anything to draw.
 *
 * It waits for the first read of the host's config before it speaks. Until then "nothing is offered"
 * and "not asked yet" look the same, and a sentence that appears and is replaced by two cards a
 * moment later would move everything under it (DESIGN.md §2).
 */
export function VoiceEmpty() {
  useLocale();
  const read = useOperatorConfigRead();
  const whistle = useWhistleStatus();
  const recording = useSttCapability();
  const { model } = useStoredModel();
  if (!read || model === undefined) return null;
  if (whistle !== null || recording !== null || model !== null) return null;
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start gap-3 p-4">
        <Mic className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 text-sm text-muted-foreground">{t("settings.voice.empty")}</p>
      </div>
    </Card>
  );
}
