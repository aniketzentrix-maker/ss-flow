import type { Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import type { SessionUser } from "@/lib/auth/session";
import { plantIdsForSession } from "@/lib/access";
import { AppError } from "@/lib/errors";
import { uuidv7 } from "@/lib/ids";
import { audit, nextNumber, notifyUsers, runCommand, usersWithPermission } from "@/lib/inventory/post";
import { allow } from "@/modules/shared/allow";
import { addLeadActivity, recordLeadStatus } from "@/modules/leads/record";
import { canTransitionLead } from "@/modules/leads/status";
import { leadEmailSubject } from "@/modules/leads/lead-email";
import { queueCustomerNotification } from "@/modules/leads/customer-notify";
import { deliverCustomerNotificationById } from "@/modules/leads/deliver-customer-email";
import { defaultValidUntil } from "@/modules/leads/quotations/config";
import {
  computeLineAmount,
  computeQuotationTotals,
  lineDiscountPct,
  quotationNeedsPricingApproval,
} from "@/modules/leads/quotations/pricing";
import {
  quotationCanRevise,
  quotationCanSend,
  quotationIsEditable,
  type QuotationSentVia,
} from "@/modules/leads/quotations/status";
import { quotationDetail, quotationDetailInclude, serializeQuotation } from "@/modules/leads/quotations/queries";
import { renderQuotationHtml } from "@/modules/leads/quotations/pdf-html";
import { saveSentDocumentHtml } from "@/modules/leads/quotations/sent-document-html";
import {
  buildLeadItemGradeColumn,
  buildLeadItemLineDescription,
  buildLeadItemSizeColumn,
} from "@/modules/leads/quotations/line-description";
import {
  assertLeadItemsPricedForFinalQuotation,
  leadItemHasSavedQuotationRate,
} from "@/modules/leads/quotations/pending-rates";
import { normalizeProductGst } from "@/lib/domain/gst";

type Tx = Prisma.TransactionClient;

export type QuotationLineWrite = {
  leadItemId?: string;
  productId?: string;
  description?: string;
  grade?: string;
  size?: string;
  qty: string;
  uom: string;
  listRate?: string;
  rate: string;
  pricingBasis?: string;
  gstPercent?: string;
  expectedDeliveryDate?: string;
};

function parseOptionalDateOnly(value?: string | null): Date | null {
  if (!value?.trim()) return null;
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateOnlyIso(value: Date | null | undefined): string | undefined {
  if (!value) return undefined;
  return value.toISOString().slice(0, 10);
}

export type QuotationHeaderWrite = {
  validUntil?: string;
  paymentTerms?: string;
  deliveryTerms?: string;
  deliveryTimeDays?: number;
  freightAmount?: string;
  loadingCharges?: string;
  gstPercent?: string;
  notes?: string;
  includesMtc?: boolean;
  thirdPartyInspection?: boolean;
  items?: QuotationLineWrite[];
};

function parseSpecs(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

async function loadLeadForQuote(tx: Tx, leadId: string, plantIds: string[]) {
  const lead = await tx.lead.findFirst({
    where: { id: leadId, plantId: { in: plantIds }, deletedAt: null },
    include: {
      items: {
        orderBy: { id: "asc" },
        include: {
          product: { select: { name: true, code: true, grade: true, sellingPrice: true, taxRate: true } },
          parentProduct: { select: { name: true, sku: true, gstPercent: true } },
          productVariant: { select: { displayName: true, sku: true } },
        },
      },
    },
  });
  if (!lead) throw new AppError(404, "NOT_FOUND", "Lead not found.");
  if (!lead.items.length) throw new AppError(400, "VALIDATION", "Add requested items before creating a quotation.");
  return lead;
}

async function syncLeadItemPricesFromLines(tx: Tx, lines: QuotationLineWrite[] | undefined) {
  if (!lines?.length) return;
  const updates = lines.flatMap((line) => {
    if (!line.leadItemId) return [];
    const market = line.listRate?.trim();
    const offer = line.rate?.trim();
    if (!market && !offer) return [];
    return [
      tx.leadItem.update({
        where: { id: line.leadItemId },
        data: {
          ...(market ? { marketPrice: new Decimal(market) } : {}),
          ...(offer ? { priceOffered: new Decimal(offer) } : {}),
        },
      }),
    ];
  });
  if (updates.length) await Promise.all(updates);
}

async function syncLeadItemPricesFromQuotationItems(
  tx: Tx,
  items: { leadItemId: string | null; listRate: Decimal | null; rate: Decimal }[],
) {
  const updates = items.flatMap((item) => {
    if (!item.leadItemId) return [];
    return [
      tx.leadItem.update({
        where: { id: item.leadItemId },
        data: {
          marketPrice: item.listRate,
          priceOffered: item.rate,
        },
      }),
    ];
  });
  if (updates.length) await Promise.all(updates);
}

function linesFromLeadItems(
  items: Awaited<ReturnType<typeof loadLeadForQuote>>["items"],
): QuotationLineWrite[] {
  // Use the lead's saved applied rate only. Never re-read live MaterialMaster.sellingPrice
  // so a later Product Master price change cannot rewrite an older lead quotation.
  // Callers that build a final quotation from lead items must assert pending rates first.
  return items.flatMap((item) => {
    if (!leadItemHasSavedQuotationRate(item)) return [];
    const list =
      item.marketPrice?.toString()?.trim() ||
      item.targetPrice?.toString()?.trim() ||
      "";
    const rate =
      item.priceOffered?.toString()?.trim() ||
      item.targetPrice?.toString()?.trim() ||
      item.marketPrice?.toString()?.trim() ||
      "";
    const lineSource = {
      itemDescription: item.itemDescription,
      specifications: item.specifications,
      sizeOrCapacity: item.sizeOrCapacity,
      mfgGrade: item.mfgGrade,
      gaugeThicknessMm: item.gaugeThicknessMm,
      product: item.product,
      parentProduct: item.parentProduct,
      productVariant: item.productVariant,
    };
    const gradeCol = buildLeadItemGradeColumn(lineSource);
    const sizeCol = buildLeadItemSizeColumn(lineSource);
    const gstFromProduct =
      item.parentProduct?.gstPercent != null
        ? normalizeProductGst(item.parentProduct.gstPercent.toString())
        : item.product?.taxRate != null
          ? normalizeProductGst(item.product.taxRate.toString())
          : "18";
    return [
      {
        leadItemId: item.id,
        productId: item.productId ?? undefined,
        description: buildLeadItemLineDescription(lineSource),
        grade: gradeCol === "—" ? undefined : gradeCol,
        size: sizeCol === "—" ? undefined : sizeCol,
        qty: item.quantity.toString(),
        uom: item.uom,
        listRate: list,
        rate,
        pricingBasis: item.pricingBasis ?? undefined,
        gstPercent: gstFromProduct,
        expectedDeliveryDate: dateOnlyIso(item.expectedDeliveryDate),
      },
    ];
  });
}

async function buildItemRows(tx: Tx, plantId: string, lines: QuotationLineWrite[]) {
  const rows: {
    id: string;
    sortOrder: number;
    leadItemId: string | null;
    productId: string | null;
    description: string | null;
    grade: string | null;
    size: string | null;
    qty: Decimal;
    uom: string;
    listRate: Decimal | null;
    rate: Decimal;
    pricingBasis: string | null;
    discountPct: Decimal | null;
    amount: Decimal;
    gstPercent: Decimal;
    expectedDeliveryDate: Date | null;
  }[] = [];

  const leadItemIds = [...new Set(lines.map((line) => line.leadItemId).filter((id): id is string => Boolean(id)))];
  const leadItems = leadItemIds.length
    ? await tx.leadItem.findMany({
        where: { id: { in: leadItemIds } },
        include: {
          product: { select: { name: true, code: true, grade: true, taxRate: true } },
          parentProduct: { select: { name: true, sku: true, gstPercent: true } },
          productVariant: { select: { displayName: true, sku: true } },
        },
      })
    : [];
  const leadItemById = new Map(leadItems.map((row) => [row.id, row]));

  const provisionalProductIds = [
    ...new Set(
      lines
        .map((line) => line.productId ?? (line.leadItemId ? leadItemById.get(line.leadItemId)?.productId : null) ?? null)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const materials = provisionalProductIds.length
    ? await tx.materialMaster.findMany({
        where: { id: { in: provisionalProductIds }, plantId, active: true, salesAllowed: true },
        select: { id: true, taxRate: true },
      })
    : [];
  const materialById = new Map(materials.map((row) => [row.id, row]));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let productId = line.productId ?? null;
    let description = line.description?.trim() || null;
    let grade = line.grade?.trim() || null;
    let size = line.size?.trim() || null;
    let expectedDeliveryDate = parseOptionalDateOnly(line.expectedDeliveryDate);
    let gstPercent = line.gstPercent ? normalizeProductGst(line.gstPercent) : null;

    if (line.leadItemId) {
      const leadItem = leadItemById.get(line.leadItemId);
      if (!productId) productId = leadItem?.productId ?? null;
      if (leadItem) {
        const lineSource = {
          itemDescription: leadItem.itemDescription,
          specifications: leadItem.specifications,
          sizeOrCapacity: leadItem.sizeOrCapacity,
          mfgGrade: leadItem.mfgGrade,
          gaugeThicknessMm: leadItem.gaugeThicknessMm,
          product: leadItem.product,
          parentProduct: leadItem.parentProduct,
          productVariant: leadItem.productVariant,
        };
        const gradeCol = buildLeadItemGradeColumn(lineSource);
        const sizeCol = buildLeadItemSizeColumn(lineSource);
        description = buildLeadItemLineDescription(lineSource);
        grade = gradeCol === "—" ? grade : gradeCol;
        size = sizeCol === "—" ? size : sizeCol;
        if (!expectedDeliveryDate && leadItem.expectedDeliveryDate) {
          expectedDeliveryDate = leadItem.expectedDeliveryDate;
        }
        if (!gstPercent) {
          gstPercent =
            leadItem.parentProduct?.gstPercent != null
              ? normalizeProductGst(leadItem.parentProduct.gstPercent.toString())
              : leadItem.product?.taxRate != null
                ? normalizeProductGst(leadItem.product.taxRate.toString())
                : null;
        }
      }
    }

    if (productId) {
      const product = materialById.get(productId);
      if (!product) throw new AppError(400, "VALIDATION", "Each line must reference an active sales product.");
      if (!gstPercent && product.taxRate != null) {
        gstPercent = normalizeProductGst(product.taxRate.toString());
      }
    }
    const listNum = line.listRate ? Number(line.listRate) : 0;
    const rateNum = Number(line.rate);
    if (!Number.isFinite(rateNum) || rateNum < 0) {
      throw new AppError(400, "VALIDATION", "Each line needs a valid rate.");
    }
    const amount = computeLineAmount(line.qty, line.rate);
    const resolvedGst = normalizeProductGst(gstPercent);
    rows.push({
      id: uuidv7(),
      sortOrder: i,
      leadItemId: line.leadItemId ?? null,
      productId,
      description,
      grade,
      size,
      qty: new Decimal(line.qty),
      uom: line.uom?.trim() || "PCS",
      listRate: line.listRate ? new Decimal(line.listRate) : null,
      rate: new Decimal(line.rate),
      pricingBasis: line.pricingBasis?.trim().toUpperCase() || null,
      discountPct: listNum > 0 ? new Decimal(lineDiscountPct(listNum, rateNum)) : null,
      amount: new Decimal(amount),
      gstPercent: new Decimal(resolvedGst),
      expectedDeliveryDate,
    });
  }
  return rows;
}

function dominantGstPercent(itemRows: { gstPercent: Decimal }[], fallback?: string) {
  const counts = new Map<string, number>();
  for (const row of itemRows) {
    const key = normalizeProductGst(row.gstPercent.toString());
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = normalizeProductGst(fallback);
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key as "5" | "18";
      bestCount = count;
    }
  }
  return best;
}

function headerTotals(input: QuotationHeaderWrite, itemRows: { amount: Decimal; gstPercent: Decimal }[]) {
  const headerGst = input.gstPercent
    ? normalizeProductGst(input.gstPercent)
    : dominantGstPercent(itemRows, "18");
  const totals = computeQuotationTotals({
    lines: itemRows.map((row) => ({
      amount: row.amount.toString(),
      gstPercent: normalizeProductGst(row.gstPercent.toString()),
    })),
    freightAmount: input.freightAmount ?? "0",
    loadingCharges: input.loadingCharges ?? "0",
    gstPercent: headerGst,
  });
  return { ...totals, headerGst };
}

async function syncLeadAfterQuoteSend(
  tx: Tx,
  lead: { id: string; status: string; orderType: string | null },
  userId: string,
  quotationNumber: string,
  version: number,
  fromRevision: boolean,
) {
  const target: "QUOTATION_SENT" | "NEGOTIATION" | null = fromRevision || lead.status === "NEGOTIATION"
    ? "NEGOTIATION"
    : "QUOTATION_SENT";

  if (target && lead.status !== target && canTransitionLead(lead.status, target, { orderType: lead.orderType })) {
    // recordLeadStatus updates lead status + lastActivityAt once; activity skips a second lead write.
    await recordLeadStatus(tx, lead.id, userId, lead.status, target, `Quotation ${quotationNumber} v${version} sent`);
    await addLeadActivity(tx, {
      leadId: lead.id,
      userId,
      activityType: "quotation",
      description: `Quotation ${quotationNumber} (v${version}) marked sent; a copy was saved on this lead.`,
      skipLeadUpdate: true,
    });
    return;
  }

  await addLeadActivity(tx, {
    leadId: lead.id,
    userId,
    activityType: "quotation",
    description: `Quotation ${quotationNumber} (v${version}) marked sent; a copy was saved on this lead.`,
  });
}

export async function createQuotationDraft(
  session: SessionUser,
  leadId: string,
  input: QuotationHeaderWrite & { fromQuotationId?: string },
  key: string | null,
) {
  allow(session, "lead.manage");
  const plantIds = await plantIdsForSession(session);
  return runCommand({
    userId: session.userId,
    route: "quotation.create",
    key,
    run: async (tx) => {
      const lead = await loadLeadForQuote(tx, leadId, plantIds);
      const plantId = lead.plantId;

      let version = 1;
      let groupId = uuidv7();
      let parentQuotationId: string | null = null;
      const sourcingFromLeadItems = !input.items?.length && !input.fromQuotationId;
      // Final quotation from lead: block entirely when any line is rate-pending.
      // Do this before writing quotation header/lines. Draft-lead saves stay untouched.
      if (sourcingFromLeadItems) {
        assertLeadItemsPricedForFinalQuotation(lead.items);
      }
      let lines = input.items && input.items.length > 0 ? input.items : linesFromLeadItems(lead.items);

      if (input.fromQuotationId) {
        const source = await tx.quotation.findFirst({
          where: { id: input.fromQuotationId, leadId, plantId },
          include: { items: { orderBy: { sortOrder: "asc" } } },
        });
        if (!source) throw new AppError(404, "NOT_FOUND", "Source quotation not found.");
        if (!input.items?.length) {
          lines = source.items.map((item) => ({
            leadItemId: item.leadItemId ?? undefined,
            productId: item.productId ?? undefined,
            description: item.description ?? undefined,
            grade: item.grade ?? undefined,
            size: item.size ?? undefined,
            qty: item.qty.toString(),
            uom: item.uom,
            listRate: item.listRate?.toString(),
            rate: item.rate.toString(),
            pricingBasis: item.pricingBasis ?? undefined,
            gstPercent: normalizeProductGst(item.gstPercent?.toString()),
            expectedDeliveryDate: dateOnlyIso(item.expectedDeliveryDate),
          }));
        }
      }

      const itemRows = await buildItemRows(tx, plantId, lines);
      const totals = headerTotals(input, itemRows);
      const approvalRequired = quotationNeedsPricingApproval(
        itemRows.map((row) => ({
          listRate: row.listRate?.toString(),
          rate: row.rate.toString(),
        })),
      );

      const quotationNumber = await nextNumber(tx, plantId, "QT");
      const validUntil = input.validUntil ? new Date(input.validUntil) : defaultValidUntil();
      const id = uuidv7();

      await tx.quotation.create({
        data: {
          id,
          plantId,
          leadId,
          quotationNumber,
          version,
          groupId,
          parentQuotationId,
          status: "DRAFT",
          validUntil,
          paymentTerms: input.paymentTerms?.trim() || null,
          deliveryTerms: input.deliveryTerms?.trim() || null,
          deliveryTimeDays: input.deliveryTimeDays ?? null,
          freightAmount: new Decimal(input.freightAmount ?? "0"),
          loadingCharges: new Decimal(input.loadingCharges ?? "0"),
          gstPercent: new Decimal(totals.headerGst),
          taxBreakup: totals.taxBreakup as Prisma.InputJsonObject,
          subtotal: new Decimal(totals.subtotal),
          total: new Decimal(totals.total),
          notes: input.notes?.trim() || null,
          includesMtc: input.includesMtc ?? false,
          thirdPartyInspection: input.thirdPartyInspection ?? false,
          approvalRequired,
          approvedById: null,
          approvedAt: null,
          createdById: session.userId,
          items: {
            create: itemRows.map(({ id: itemId, ...row }) => ({ id: itemId, ...row })),
          },
        },
      });

      await audit(tx, {
        userId: session.userId,
        action: "quotation.create",
        resource: "quotation",
        resourceId: id,
        payload: { leadId, quotationNumber, version },
      });

      return { id, quotationNumber, version };
    },
  });
}

export async function updateQuotationDraft(
  session: SessionUser,
  quotationId: string,
  input: QuotationHeaderWrite,
  key: string | null,
) {
  allow(session, "lead.manage");
  const plantIds = await plantIdsForSession(session);
  return runCommand({
    userId: session.userId,
    route: "quotation.update",
    key,
    run: async (tx) => {
      const existing = await tx.quotation.findFirst({
        where: { id: quotationId, plantId: { in: plantIds } },
      });
      if (!existing) throw new AppError(404, "NOT_FOUND", "Quotation not found.");
      if (!quotationIsEditable(existing.status)) {
        throw new AppError(409, "INVALID_STATE", "Only draft quotations can be edited.");
      }

      const lead = await loadLeadForQuote(tx, existing.leadId, [existing.plantId]);
      const incoming = input.items ?? [];
      const coveredLeadItems = new Set(incoming.map((l) => l.leadItemId).filter(Boolean));
      const missingFromLead = lead.items.filter((item) => !coveredLeadItems.has(item.id));
      const mergedLines =
        missingFromLead.length > 0 ? [...incoming, ...linesFromLeadItems(missingFromLead)] : incoming;

      const itemRows = await buildItemRows(tx, existing.plantId, mergedLines);
      const totals = headerTotals(input, itemRows);
      const approvalRequired = quotationNeedsPricingApproval(
        itemRows.map((row) => ({
          listRate: row.listRate?.toString(),
          rate: row.rate.toString(),
        })),
      );

      await tx.quotationItem.deleteMany({ where: { quotationId } });
      await tx.quotation.update({
        where: { id: quotationId },
        data: {
          validUntil: input.validUntil ? new Date(input.validUntil) : existing.validUntil,
          paymentTerms: input.paymentTerms?.trim() || null,
          deliveryTerms: input.deliveryTerms?.trim() || null,
          deliveryTimeDays: input.deliveryTimeDays ?? null,
          freightAmount: new Decimal(input.freightAmount ?? "0"),
          loadingCharges: new Decimal(input.loadingCharges ?? "0"),
          gstPercent: new Decimal(totals.headerGst),
          taxBreakup: totals.taxBreakup as Prisma.InputJsonObject,
          subtotal: new Decimal(totals.subtotal),
          total: new Decimal(totals.total),
          notes: input.notes?.trim() || null,
          includesMtc: input.includesMtc ?? false,
          thirdPartyInspection: input.thirdPartyInspection ?? false,
          approvalRequired,
          approvedById: approvalRequired ? null : existing.approvedById,
          approvedAt: approvalRequired ? null : existing.approvedAt,
          items: {
            create: itemRows.map(({ id: itemId, ...row }) => ({ id: itemId, ...row })),
          },
        },
      });

      await syncLeadItemPricesFromLines(tx, mergedLines);
      await addLeadActivity(tx, {
        leadId: existing.leadId,
        userId: session.userId,
        activityType: "quotation",
        description: "Quotation draft pricing saved on lead items (market & offer rates).",
      });

      if (approvalRequired && !existing.approvedAt) {
        const approverIds = await usersWithPermission(tx, existing.plantId, "quotation.approve");
        const notifyIds = approverIds.filter((id) => id !== session.userId);
        if (notifyIds.length) {
          await notifyUsers(tx, {
            userIds: notifyIds,
            type: "quotation.pending_approval",
            title: `Quotation pricing needs approval`,
            body: `${existing.quotationNumber} v${existing.version} — offer prices updated on lead.`,
            href: `/leads/${existing.leadId}`,
            payload: { quotationId, leadId: existing.leadId },
          });
        }
      }

      return { id: quotationId };
    },
  });
}

export async function approveQuotation(session: SessionUser, quotationId: string, key: string | null) {
  allow(session, "quotation.approve");
  const plantIds = await plantIdsForSession(session);
  return runCommand({
    userId: session.userId,
    route: "quotation.approve",
    key,
    run: async (tx) => {
      const quote = await tx.quotation.findFirst({ where: { id: quotationId, plantId: { in: plantIds } } });
      if (!quote) throw new AppError(404, "NOT_FOUND", "Quotation not found.");
      if (quote.status !== "DRAFT") throw new AppError(409, "INVALID_STATE", "Only draft quotations can be approved.");
      if (quote.approvedAt) {
        throw new AppError(409, "INVALID_STATE", "This quotation is already approved.");
      }
      const itemCount = await tx.quotationItem.count({ where: { quotationId } });
      if (!itemCount) {
        throw new AppError(400, "VALIDATION", "Add quotation lines with offer rates before approval.");
      }
      await tx.quotation.update({
        where: { id: quotationId },
        data: { approvedById: session.userId, approvedAt: new Date() },
      });
      await audit(tx, {
        userId: session.userId,
        action: "quotation.approve",
        resource: "quotation",
        resourceId: quotationId,
      });
      return { id: quotationId };
    },
  });
}

export async function sendQuotation(
  session: SessionUser,
  quotationId: string,
  input: { sentVia: QuotationSentVia },
  key: string | null,
) {
  allow(session, "lead.manage");
  const plantIds = await plantIdsForSession(session);
  return runCommand({
    userId: session.userId,
    route: "quotation.send",
    key,
    run: async (tx) => {
      const quote = await tx.quotation.findFirst({
        where: { id: quotationId, plantId: { in: plantIds } },
        include: quotationDetailInclude,
      });
      if (!quote) throw new AppError(404, "NOT_FOUND", "Quotation not found.");
      if (!quotationCanSend(quote.status)) {
        throw new AppError(409, "INVALID_STATE", "Only draft quotations can be sent.");
      }
      if (!quote.approvedAt) {
        throw new AppError(
          409,
          "APPROVAL_REQUIRED",
          "Admin must approve pricing before sending to customer.",
        );
      }
      if (quote.validUntil.getTime() < Date.now()) {
        throw new AppError(409, "EXPIRED", "Valid-until date is in the past. Update validity before sending.");
      }

      const fromRevision = Boolean(quote.parentQuotationId);
      const sentAt = new Date();
      const sentDocumentHtml = renderQuotationHtml(quote, {
        archived: true,
        sentAt,
        sentVia: input.sentVia,
      });
      await tx.quotation.update({
        where: { id: quotationId },
        data: {
          status: "SENT",
          sentAt,
          sentVia: input.sentVia,
        },
      });
      await saveSentDocumentHtml(tx, quotationId, sentDocumentHtml);

      await syncLeadItemPricesFromQuotationItems(tx, quote.items);
      await syncLeadAfterQuoteSend(
        tx,
        quote.lead,
        session.userId,
        quote.quotationNumber,
        quote.version,
        fromRevision,
      );

      let emailNotificationId: string | null = null;
      if (input.sentVia === "EMAIL") {
        const toEmail = quote.lead.email?.trim();
        if (!toEmail) {
          throw new AppError(400, "VALIDATION", "Lead has no email address. Use WhatsApp or manual send.");
        }
        const total = quote.total.toString();
        const message =
          `Dear ${quote.lead.customerName},\n\n` +
          `Please find our quotation ${quote.quotationNumber} (version ${quote.version}) for your enquiry ${quote.lead.leadNumber}.\n` +
          `Quoted total (incl. charges as per quote): ₹${total}.\n\n` +
          `Our team will share the detailed PDF shortly. Contact us for any clarifications.\n\n` +
          `Regards,\nSS Metals`;
        emailNotificationId = await queueCustomerNotification(tx, {
          plantId: quote.plantId,
          leadId: quote.leadId,
          channel: "email",
          message,
          toEmail,
          subject: leadEmailSubject(quote.lead.leadNumber, `Quotation ${quote.quotationNumber}`),
        });
      }

      return { id: quotationId, status: "SENT" as const, emailNotificationId };
    },
  }).then(async (result) => {
    if (result.emailNotificationId) {
      void deliverCustomerNotificationById(result.emailNotificationId).catch((error) =>
        console.error("[quotation.send.email]", result.emailNotificationId, error),
      );
    }
    return { id: result.id, status: result.status };
  });
}

export async function reviseQuotation(session: SessionUser, quotationId: string, key: string | null) {
  allow(session, "lead.manage");
  const plantIds = await plantIdsForSession(session);
  return runCommand({
    userId: session.userId,
    route: "quotation.revise",
    key,
    run: async (tx) => {
      const source = await tx.quotation.findFirst({
        where: { id: quotationId, plantId: { in: plantIds } },
        include: {
          items: { orderBy: { sortOrder: "asc" } },
          lead: { select: { id: true, status: true, orderType: true } },
        },
      });
      if (!source) throw new AppError(404, "NOT_FOUND", "Quotation not found.");
      if (!quotationCanRevise(source.status)) {
        throw new AppError(409, "INVALID_STATE", "Only sent or expired quotations can be revised.");
      }

      await tx.quotation.update({
        where: { id: source.id },
        data: { status: "SUPERSEDED" },
      });

      const nextVersion =
        (
          await tx.quotation.aggregate({
            where: { groupId: source.groupId },
            _max: { version: true },
          })
        )._max.version ?? source.version;

      const lines: QuotationLineWrite[] = source.items.map((item) => ({
        leadItemId: item.leadItemId ?? undefined,
        productId: item.productId ?? undefined,
        description: item.description ?? undefined,
        grade: item.grade ?? undefined,
        size: item.size ?? undefined,
        qty: item.qty.toString(),
        uom: item.uom,
        listRate: item.listRate?.toString(),
        rate: item.rate.toString(),
        pricingBasis: item.pricingBasis ?? undefined,
        gstPercent: normalizeProductGst(item.gstPercent?.toString()),
        expectedDeliveryDate: dateOnlyIso(item.expectedDeliveryDate),
      }));

      const itemRows = await buildItemRows(tx, source.plantId, lines);
      const totals = headerTotals(
        {
          freightAmount: source.freightAmount.toString(),
          loadingCharges: source.loadingCharges.toString(),
          gstPercent: source.gstPercent.toString(),
        },
        itemRows,
      );
      const approvalRequired = quotationNeedsPricingApproval(
        itemRows.map((row) => ({
          listRate: row.listRate?.toString(),
          rate: row.rate.toString(),
        })),
      );

      const id = uuidv7();
      const validUntil = defaultValidUntil();

      await tx.quotation.create({
        data: {
          id,
          plantId: source.plantId,
          leadId: source.leadId,
          quotationNumber: source.quotationNumber,
          version: nextVersion + 1,
          groupId: source.groupId,
          parentQuotationId: source.id,
          status: "DRAFT",
          validUntil,
          paymentTerms: source.paymentTerms,
          deliveryTerms: source.deliveryTerms,
          deliveryTimeDays: source.deliveryTimeDays,
          freightAmount: source.freightAmount,
          loadingCharges: source.loadingCharges,
          gstPercent: new Decimal(totals.headerGst),
          taxBreakup: totals.taxBreakup as Prisma.InputJsonObject,
          subtotal: new Decimal(totals.subtotal),
          total: new Decimal(totals.total),
          notes: source.notes,
          includesMtc: source.includesMtc,
          thirdPartyInspection: source.thirdPartyInspection,
          approvalRequired,
          approvedById: null,
          approvedAt: null,
          createdById: session.userId,
          items: {
            create: itemRows.map(({ id: itemId, ...row }) => ({ id: itemId, ...row })),
          },
        },
      });

      if (
        source.lead.status !== "NEGOTIATION" &&
        canTransitionLead(source.lead.status, "NEGOTIATION", { orderType: source.lead.orderType })
      ) {
        await recordLeadStatus(
          tx,
          source.lead.id,
          session.userId,
          source.lead.status,
          "NEGOTIATION",
          `Revision draft for ${source.quotationNumber} v${nextVersion + 1}`,
        );
      }

      await addLeadActivity(tx, {
        leadId: source.leadId,
        userId: session.userId,
        activityType: "quotation",
        description: `Started revision v${nextVersion + 1} from ${source.quotationNumber} v${source.version}.`,
      });

      return { id, version: nextVersion + 1 };
    },
  });
}

export async function markQuotationAccepted(tx: Tx, quotationId: string, userId: string) {
  const quote = await tx.quotation.findUnique({ where: { id: quotationId } });
  if (!quote) return;
  if (quote.status === "ACCEPTED") return;
  if (quote.status !== "SENT" && quote.status !== "DRAFT") return;
  await tx.quotation.update({
    where: { id: quotationId },
    data: { status: "ACCEPTED" },
  });
  await addLeadActivity(tx, {
    leadId: quote.leadId,
    userId,
    activityType: "quotation",
    description: `Quotation ${quote.quotationNumber} v${quote.version} accepted on conversion.`,
  });
}

export async function getQuotationForSession(session: SessionUser, id: string) {
  allow(session, "lead.view");
  const plantIds = await plantIdsForSession(session);
  const row = await quotationDetail(id, plantIds);
  if (!row) throw new AppError(404, "NOT_FOUND", "Quotation not found.");
  return serializeQuotation(row);
}
