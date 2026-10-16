"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireWriter } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import { money } from "@/lib/format";
import { simplePdf } from "@/lib/pdf";
import { saveFile } from "@/lib/storage";
import { computeStatement } from "@/server/statements";
import { getTranslations, getLocale } from "next-intl/server";
import {
  buildStatementMailTexts,
  resolveStatementLocale,
  type StatementMailTexts,
} from "./statement-mail-texts";
import type { ActionState } from "@/lib/schemas";

/**
 * HAVEWA-05B-2: Server-Action-Signatur erweitert um `locale` (FormData-Feld).
 *
 * Locale-Quelle (C1): `locale` aus dem FormData, NICHT `session.user.locale`
 * (LanguageSwitcher aktualisiert User.locale nicht zuverlässig) und NICHT
 * `getLocale()` (in Server Actions unzuverlässig).
 *
 * `getLocale()` wird hier nur als RÜCKFALL benutzt, wenn der Caller kein
 * `locale`-Feld mitgibt (z. B. alter Client-Code, externe Test-Aufrufer). In
 * diesem Fall wird der aufgelöste Wert gegen routing.locales validiert (C6)
 * und fällt im Zweifel auf `de` zurück.
 *
 * `NK-Nachzahlung {year}` (charge.description + Dedup-Key) bleibt
 * unverändert deutsch (C3) — Locale-Wechsel darf keine Dubletten erzeugen.
 */
function parse(fd: FormData) {
  return {
    propertyId: String(fd.get("propertyId") ?? ""),
    year: Number(fd.get("year")) || new Date().getFullYear(),
    locale: String(fd.get("locale") ?? ""),
  };
}

/**
 * Löst die aktive Locale in der dokumentierten Priorität auf:
 *   1. explizites `locale`-Feld (Caller-Kontext, z. B. UI)
 *   2. getLocale() (Request-Kontext, fallback)
 *   3. routing.defaultLocale (= "de")
 *
 * Validierung gegen routing.locales übernimmt resolveStatementLocale.
 */
async function resolveActionLocale(fd: FormData): Promise<string> {
  const explicit = String(fd.get("locale") ?? "").trim();
  if (explicit) return explicit;
  try {
    return await getLocale();
  } catch {
    return "de";
  }
}

/** Bucht die Nachzahlungen (Saldo < 0) je Einheit als Sollstellung. */
export async function bookStatementCharges(_p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireWriter();
  const { propertyId, year } = parse(fd);
  if (!propertyId) {
    const locale = resolveStatementLocale(await resolveActionLocale(fd));
    const t = await getTranslations({ locale });
    return { error: t("statements.errors.errorNoProperty") };
  }

  const st = await computeStatement(user.tenantId, propertyId, year);
  // C3: description bleibt unverändert deutsch (Dedup-Key, Audit-Reproduzierbarkeit).
  const desc = `NK-Nachzahlung ${year}`;
  const dueDate = new Date(Date.now() + 30 * 864e5);
  let created = 0;

  for (const u of st.units) {
    if (!u.leaseId || u.balance >= 0) continue; // nur Nachzahlungen
    // Dedup: nicht doppelt buchen
    const exists = await prisma.charge.findFirst({
      where: { tenantId: user.tenantId, leaseId: u.leaseId, description: desc },
      select: { id: true },
    });
    if (exists) continue;
    await prisma.charge.create({
      data: {
        tenantId: user.tenantId,
        leaseId: u.leaseId,
        type: "NEBENKOSTEN",
        period: new Date(Date.UTC(year, 11, 1)),
        dueDate,
        amount: Math.abs(u.balance),
        description: desc,
      },
    });
    created++;
  }
  if (created > 0) await audit(user, "CREATE", "Charge", null, `${created}× ${desc}`); // C3/Audit
  revalidatePath("/", "layout");
  if (created > 0) return { ok: true };
  const locale = resolveStatementLocale(await resolveActionLocale(fd));
  const t = await getTranslations({ locale });
  return { error: t("statements.errors.errorNoOpenArrears") };
}

/** Erstellt je Einheit mit Mieter-E-Mail einen Abrechnungs-Entwurf im Postausgang. */
export async function emailStatementToTenants(_p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireWriter();
  const { propertyId, year } = parse(fd);
  if (!propertyId) {
    const locale = resolveStatementLocale(await resolveActionLocale(fd));
    const t = await getTranslations({ locale });
    return { error: t("statements.errors.errorNoProperty") };
  }

  // resolveActionLocale: 1) explizites FormData-Feld, 2) getLocale() Fallback, 3) "de"
  const requestedLocale = await resolveActionLocale(fd);
  const locale = resolveStatementLocale(requestedLocale);
  const t = await getTranslations({ locale });

  const st = await computeStatement(user.tenantId, propertyId, year);
  const propName = st.property?.name ?? "";
  let created = 0;

  for (const u of st.units) {
    if (u.renterEmails.length === 0) continue;
    const texts: StatementMailTexts = buildStatementMailTexts(
      locale,
      st.property?.name ?? "",
      u.label,
      year,
      st.heatingAllocation?.mode ?? "NONE",
    );

    const balanceAbs = money(Math.abs(u.balance), locale);
    const kind = u.balance >= 0 ? t("statements.credit") : t("statements.arrears");

    const body =
      `${texts.greeting}\n\n` +
      `${texts.bodyIntro}\n\n` +
      `${texts.bodyLabels.allocated}: ${money(u.allocated, locale)}\n` +
      `${texts.bodyLabels.prepayment}: ${money(u.prepayment, locale)}\n` +
      `${texts.resultLabel}: ${balanceAbs} ${kind}\n\n` +
      `${texts.closing}\n${st.property?.tenantName ?? ""}`;

    // Heating-Hinweis nur, wenn die zugehörige i18n-Key gesetzt ist.
    // Lookup passiert im Helper (kein doppelter Production-Selektor hier).
    const heatingLine: string | null = texts.heatingLineKey ? t(texts.heatingLineKey) : null;

    // PDF erzeugen, im Storage ablegen und als Dokument (Kategorie ABRECHNUNG) archivieren.
    const pdfLines = [
      `${propName} - ${u.label}`,
      "",
      `${texts.bodyLabels.allocated}: ${money(u.allocated, locale)}`,
      `${texts.bodyLabels.prepayment}:  ${money(u.prepayment, locale)}`,
      `${texts.resultLabel}: ${balanceAbs} ${kind}`,
      "",
      ...(heatingLine ? [heatingLine] : []),
    ];
    const pdf = simplePdf(texts.pdfTitle, pdfLines);
    const storageKey = await saveFile(pdf, texts.filename);
    const doc = await prisma.document.create({
      data: {
        tenantId: user.tenantId,
        propertyId,
        name: texts.filename,
        category: "ABRECHNUNG",
        mime: "application/pdf",
        size: pdf.length,
        storageKey,
      },
    });

    await prisma.emailMessage.create({
      data: {
        tenantId: user.tenantId,
        toAddress: u.renterEmails.join(", "),
        subject: texts.subject,
        body,
        status: "ENTWURF",
        attachments: { create: [{ documentId: doc.id }] },
      },
    });
    created++;
  }
  if (created > 0) await audit(user, "CREATE", "EmailMessage", null, `${created}× Abrechnung ${year} (PDF)`);
  revalidatePath("/", "layout");
  if (created > 0) return { ok: true };
  return { error: t("statements.errors.errorNoTenantsWithEmail") };
}
