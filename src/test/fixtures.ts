import type { UserRole } from "@prisma/client";
import { prisma, resetDatabase } from "./db";
import { hashToken } from "@/lib/api-auth";

// Deterministische Seed-/Factory-Schicht für HAVEWA-03-Integrationstests.
// Zwei Mandanten (A/B) mit je allen sieben Rollen, API-Tokens und einem kleinen
// fachlichen Bestand (Property → Building → Unit → Person → Lease → Charge →
// Payment, plus Document, Task, Ticket). Keine externen Integrationen.

export const ROLES = [
  "ADMIN",
  "VERWALTER",
  "BUCHHALTUNG",
  "BEIRAT",
  "EIGENTUEMER",
  "MIETER",
  "HANDWERKER",
] as const satisfies readonly UserRole[];

export type RoleName = (typeof ROLES)[number];

export function rawTokenFor(slug: string, role: string): string {
  return `hvw_test_${slug}_${role.toLowerCase()}`;
}

export interface TenantFixture {
  id: string;
  name: string;
  users: Record<RoleName, string>; // role -> userId
  tokens: Record<RoleName, string>; // role -> raw token
  propertyId: string;
  buildingId: string;
  unitId: string;
  personId: string;
  leaseId: string;
  chargeId: string;
  paymentId: string;
  documentId: string;
  taskId: string;
  ticketId: string;
}

export interface Fixtures {
  tenantA: TenantFixture;
  tenantB: TenantFixture;
}

const START = new Date(Date.UTC(2025, 0, 1));
const PERIOD = new Date(Date.UTC(2026, 0, 1));
const DUE = new Date(Date.UTC(2026, 0, 5));

async function seedTenant(slug: string, name: string): Promise<TenantFixture> {
  const tenant = await prisma.tenant.create({
    data: {
      name,
      // Legacy-Plaintext-Secrets (für den Secret-Migration-DB-Test, HAVEWA-03).
      aiProvider: "anthropic",
      aiApiKey: `sk-ant-legacy-${slug}`,
      smtpUser: `mail@${slug}.test`,
      smtpFrom: `mail@${slug}.test`,
      smtpPassword: `smtp-geheim-${slug}`,
      imapUser: `mail@${slug}.test`,
      imapHost: `imap.${slug}.test`,
      imapPassword: `imap-geheim-${slug}`,
    },
  });

  const users = {} as Record<RoleName, string>;
  const tokens = {} as Record<RoleName, string>;
  for (const role of ROLES) {
    const email = `${slug}-${role.toLowerCase()}@test.local`;
    const user = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email,
        name: `${role} ${slug}`,
        passwordHash: "test-not-used",
        role,
        superAdmin: false,
        locale: "de",
      },
    });
    users[role] = user.id;
    const raw = rawTokenFor(slug, role);
    tokens[role] = raw;
    await prisma.apiToken.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        name: `${role}-token`,
        tokenHash: hashToken(raw),
        prefix: raw.slice(0, 12),
      },
    });
  }

  const property = await prisma.property.create({
    data: { tenantId: tenant.id, name: `Objekt ${slug}`, street: `${slug}-Straße 1`, zip: "10115", city: "Berlin", type: "WOHNEN", management: "MIET" },
  });
  const building = await prisma.building.create({
    data: { tenantId: tenant.id, name: "Haus 1", propertyId: property.id },
  });
  const unit = await prisma.unit.create({
    data: { tenantId: tenant.id, label: "EG links", type: "WOHNUNG", area: 62.5, buildingId: building.id },
  });
  const person = await prisma.person.create({
    data: { tenantId: tenant.id, firstName: "Max", lastName: `Mustermann-${slug}`, type: "MIETER" },
  });
  const lease = await prisma.lease.create({
    data: {
      tenantId: tenant.id,
      unitId: unit.id,
      startDate: START,
      rentCold: 800,
      renters: { create: { tenantId: tenant.id, personId: person.id } },
    },
  });
  const charge = await prisma.charge.create({
    data: { tenantId: tenant.id, leaseId: lease.id, type: "MIETE", period: PERIOD, dueDate: DUE, amount: 800 },
  });
  const payment = await prisma.payment.create({
    data: { tenantId: tenant.id, chargeId: charge.id, date: DUE, amount: 400, direction: "EINGANG" },
  });
  const document = await prisma.document.create({
    data: { tenantId: tenant.id, propertyId: property.id, name: `vertrag-${slug}.pdf`, mime: "application/pdf", size: 1234, storageKey: `vertrag-${slug}.pdf`, category: "VERTRAG" },
  });
  const task = await prisma.task.create({
    data: { tenantId: tenant.id, title: `Aufgabe ${slug}` },
  });
  const ticket = await prisma.ticket.create({
    data: { tenantId: tenant.id, propertyId: property.id, title: `Ticket ${slug}`, category: "SCHADEN", status: "OFFEN", priority: "MITTEL" },
  });

  return {
    id: tenant.id,
    name,
    users,
    tokens,
    propertyId: property.id,
    buildingId: building.id,
    unitId: unit.id,
    personId: person.id,
    leaseId: lease.id,
    chargeId: charge.id,
    paymentId: payment.id,
    documentId: document.id,
    taskId: task.id,
    ticketId: ticket.id,
  };
}

/** Leert die Test-DB und seeded beide Mandanten deterministisch. */
export async function resetAndSeed(): Promise<Fixtures> {
  await resetDatabase();
  const tenantA = await seedTenant("alpha", "Alpha Verwaltung GmbH");
  const tenantB = await seedTenant("beta", "Beta Verwaltung GmbH");
  return { tenantA, tenantB };
}

export function principalFor(
  fixtures: Fixtures,
  tenant: "tenantA" | "tenantB",
  role: RoleName,
): { userId: string; tenantId: string; role: UserRole; name: string } {
  const t = fixtures[tenant];
  return { userId: t.users[role], tenantId: t.id, role, name: `${role} ${tenant === "tenantA" ? "alpha" : "beta"}` };
}
