-- CreateEnum (MCP Human Approval, HAVEWA-02)
CREATE TYPE "McpApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "McpApproval" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requesterName" TEXT,
    "tool" TEXT NOT NULL,
    "operationType" TEXT,
    "entity" TEXT,
    "targetId" TEXT,
    "summary" TEXT NOT NULL,
    "argsEnc" TEXT NOT NULL,
    "status" "McpApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "McpApproval_tenantId_status_idx" ON "McpApproval"("tenantId", "status");

-- CreateIndex
CREATE INDEX "McpApproval_tenantId_requestedAt_idx" ON "McpApproval"("tenantId", "requestedAt");
