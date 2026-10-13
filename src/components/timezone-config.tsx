"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Check, TriangleAlert, Clock } from "lucide-react";
import { updateTimeZone } from "@/server/actions/config";
import type { ActionState } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

// Kuratierte Auswahl gebräuchlicher IANA-Zeitzonen. Der Server validiert jeden
// Wert zusätzlich als gültige IANA-Zeitzone (isValidIanaTimezone).
const OPTIONS = [
  "Europe/Berlin",
  "Europe/Vienna",
  "Europe/Zurich",
  "Europe/London",
  "Europe/Paris",
  "Europe/Rome",
  "Europe/Madrid",
  "Europe/Amsterdam",
  "Europe/Brussels",
  "Europe/Prague",
  "Europe/Warsaw",
  "Europe/Stockholm",
  "Europe/Copenhagen",
  "Europe/Oslo",
  "Europe/Helsinki",
  "Europe/Athens",
  "Europe/Istanbul",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

export function TimezoneConfig({ timeZone }: { timeZone: string }) {
  const t = useTranslations("settings");
  const [state, action, pending] = useActionState<ActionState, FormData>(updateTimeZone, {});

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="size-4" /> {t("timeZone")}
        </CardTitle>
        <p className="text-xs text-muted-foreground">{t("timeZoneHint")}</p>
      </CardHeader>
      <CardContent>
        <form action={action} className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="timeZone">{t("timeZone")}</Label>
            <select
              id="timeZone"
              name="timeZone"
              defaultValue={timeZone}
              className="flex h-9 w-56 rounded-lg border border-input bg-transparent px-3 text-sm dark:bg-input/30"
            >
              {OPTIONS.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={pending}>{t("save")}</Button>
          {state.error && (
            <span className="flex items-center gap-1.5 text-sm text-destructive">
              <TriangleAlert className="size-4" /> {state.error}
            </span>
          )}
          {state.ok && (
            <span className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
              <Check className="size-4" /> {t("saved")}
            </span>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
