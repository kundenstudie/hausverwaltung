import "server-only";
import { cache } from "react";
import { auth } from "@/auth";
import { actingTenantId } from "@/lib/acting-tenant";
import { prisma } from "@/lib/prisma";
import { DEFAULT_TIME_ZONE } from "@/lib/timezone";

// Effektive Mandanten-Zeitzone (IANA). Default Europe/Berlin (Altverhalten).
// Pro Request gecacht, damit nicht jede Anzeige eine DB-Abfrage auslöst.
export const getTenantTimeZone = cache(async (fallback = DEFAULT_TIME_ZONE): Promise<string> => {
  const session = await auth();
  if (!session?.user) return fallback;
  const tenantId = await actingTenantId(session.user);
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { timeZone: true } });
  return tenant?.timeZone || fallback;
});
