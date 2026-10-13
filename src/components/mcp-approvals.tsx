"use client";

import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Check, X, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { approveMcpApproval, rejectMcpApproval } from "@/server/actions/mcp-approval";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export type McpApprovalRow = {
  id: string;
  tool: string;
  summary: string;
  requesterName: string | null;
  requestedAt: string;
};

export function McpApprovals({ items }: { items: McpApprovalRow[] }) {
  const t = useTranslations("mcpApproval");
  const router = useRouter();
  const [pending, start] = useTransition();

  function decide(action: (id: string) => Promise<{ ok?: boolean; error?: string }>, id: string) {
    start(async () => {
      const res = await action(id);
      if (res.error) toast.error(res.error);
      else toast.success(t("done"));
      router.refresh();
    });
  }

  if (items.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="size-4" /> {t("title")}
        </CardTitle>
        <p className="text-xs text-muted-foreground">{t("hint")}</p>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.map((it) => (
          <div
            key={it.id}
            className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Badge variant="outline">{it.tool}</Badge>
                <span className="truncate font-medium">{it.summary}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {it.requesterName ? `${it.requesterName} · ` : ""}
                {it.requestedAt}
              </p>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => decide(approveMcpApproval, it.id)}
              >
                <Check className="size-4" /> {t("approve")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => decide(rejectMcpApproval, it.id)}
              >
                <X className="size-4" /> {t("reject")}
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
