import type { SessionUser } from "@/lib/auth/session";
import { plantIdsForSession } from "@/lib/access";
import { AppError } from "@/lib/errors";
import { prisma } from "@/db";
import { allow } from "@/modules/shared/allow";
import { changeLeadStatus, convertLeadToSalesOrder } from "@/modules/leads/commands";
import {
  approveQuotation,
  createQuotationDraft,
  sendQuotation,
} from "@/modules/leads/quotations/commands";

export type FinalizeSuccessMode = "quotation" | "sales_order";

function followUpIsoDaysFromNow(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setSeconds(0, 0);
  return d.toISOString();
}

/**
 * Office Result=SUCCESS shortcut after lead create:
 * - quotation: Contacted → draft → approve → send (MANUAL)
 * - sales_order: same, then convert to draft sales order
 */
export async function finalizeSuccessfulLeadDeal(
  session: SessionUser,
  leadId: string,
  mode: FinalizeSuccessMode,
  key: string | null,
) {
  allow(session, "lead.manage");
  if (mode === "sales_order") {
    allow(session, "lead.convert");
    allow(session, "quotation.approve");
  }

  const canApprove = session.permissions.has("quotation.approve");
  if (mode === "sales_order" && !canApprove) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Quotation pricing approval permission is required to create the sales order from a Success lead.",
    );
  }

  const plantIds = await plantIdsForSession(session);
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, plantId: { in: plantIds }, deletedAt: null },
    select: {
      id: true,
      status: true,
      result: true,
      salesOrderId: true,
      items: {
        select: {
          id: true,
          productId: true,
          itemDescription: true,
          marketPrice: true,
          targetPrice: true,
          priceOffered: true,
        },
      },
    },
  });
  if (!lead) throw new AppError(404, "NOT_FOUND", "Lead not found.");
  if ((lead.result ?? "").toUpperCase() !== "SUCCESS") {
    throw new AppError(
      400,
      "VALIDATION",
      "Official follow-up Result must be Success before sending quotation or creating the sales order.",
    );
  }
  if (lead.salesOrderId) {
    throw new AppError(409, "INVALID_STATE", "This lead already has a sales order.");
  }

  const unpriced = lead.items.filter((item) => {
    const rate =
      item.priceOffered?.toString()?.trim() ||
      item.targetPrice?.toString()?.trim() ||
      item.marketPrice?.toString()?.trim() ||
      "";
    const num = Number(rate);
    return !item.productId || !rate || !Number.isFinite(num) || num <= 0;
  });
  if (unpriced.length) {
    throw new AppError(
      400,
      "VALIDATION",
      "Every item needs a linked product and a positive unit price before Success can create a quotation / sales order.",
      {
        pendingItemIds: unpriced.map((row) => row.id),
      },
    );
  }

  // NEW cannot jump straight to QUOTATION_SENT — move to Contacted first.
  if (lead.status === "NEW") {
    await changeLeadStatus(
      session,
      leadId,
      {
        status: "CONTACTED",
        nextFollowUpAt: followUpIsoDaysFromNow(7),
        reason: "Office follow-up marked Success on create",
      },
      key ? `${key}:contacted` : null,
    );
  }

  const draft = await createQuotationDraft(session, leadId, {}, key ? `${key}:quote` : null);

  if (!canApprove) {
    // Quotation-only path without approve rights: leave a draft for the detail page.
    return {
      leadId,
      quotationId: draft.id,
      quotationNumber: draft.quotationNumber,
      salesOrderId: null as string | null,
      salesOrderNumber: null as string | null,
      mode,
      pendingApproval: true,
    };
  }

  try {
    await approveQuotation(session, draft.id, key ? `${key}:approve` : null);
  } catch (error) {
    // Already approved is fine.
    if (!(error instanceof AppError && error.code === "INVALID_STATE")) throw error;
  }

  await sendQuotation(session, draft.id, { sentVia: "MANUAL" }, key ? `${key}:send` : null);

  if (mode === "quotation") {
    return {
      leadId,
      quotationId: draft.id,
      quotationNumber: draft.quotationNumber,
      salesOrderId: null as string | null,
      salesOrderNumber: null as string | null,
      mode,
      pendingApproval: false,
    };
  }

  const refreshed = await prisma.lead.findFirst({
    where: { id: leadId },
    select: {
      items: { select: { id: true, productId: true } },
    },
  });
  if (!refreshed?.items.length) {
    throw new AppError(400, "VALIDATION", "Lead items missing after quotation send.");
  }

  const converted = await convertLeadToSalesOrder(
    session,
    leadId,
    {
      quotationId: draft.id,
      lines: refreshed.items.map((item) => ({
        leadItemId: item.id,
        productId: item.productId ?? undefined,
      })),
    },
    key ? `${key}:convert` : null,
  );

  return {
    leadId,
    quotationId: draft.id,
    quotationNumber: draft.quotationNumber,
    salesOrderId: converted.salesOrderId,
    salesOrderNumber: converted.number,
    mode,
  };
}
