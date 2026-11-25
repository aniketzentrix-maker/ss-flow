import type { Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import type { SessionUser } from "@/lib/auth/session";
import { plantIdsForSession, primaryPlant } from "@/lib/access";
import { AppError } from "@/lib/errors";
import { uuidv7 } from "@/lib/ids";
import { audit, nextNumber, notifyUsers, runCommand } from "@/lib/inventory/post";
import { createCustomerInTx } from "@/lib/masters";
import { allow } from "@/modules/shared/allow";
import { leadEmailSubject, notifyLeadByEmail, notifyLeadStatusEmail } from "@/modules/leads/lead-email";
import { addLeadActivity, recordLeadStatus } from "@/modules/leads/record";
import {
  assertNextFollowUpForStatus,
  firstContactMetrics,
  parseFollowUpAt,
} from "@/modules/leads/follow-up";
import {
  assertLeadTransition,
  leadCanConvert,
  leadCanVerify,
  leadRequiresLostReason,
  type LeadSource,
  type LeadStatus,
} from "@/modules/leads/status";
import { markQuotationAccepted } from "@/modules/leads/quotations/commands";
import { quotationCanAcceptOnConvert } from "@/modules/leads/quotations/status";
import { formatLostReasonLegacyColumn } from "@/modules/leads/lost-reason";
import {
  addCalendarDays,
  resolveRepeatOrderFollowUpDays,
} from "@/modules/leads/repeat-order-follow-up";
import {
  extractDesignFileIds,
  flattenVariantSpecs,
  isProductComingSoon,
  RATE_AMBIGUOUS_MESSAGE,
  RATE_PENDING_MESSAGE,
  resolveExactPricedVariant,
  resolveProductFieldConfig,
} from "@/lib/domain/product-spec-fields";
import { isValidGstin, leadIdentityPatch } from "@/modules/leads/duplicates";
import { normalizeLeadOrderType } from "@/modules/leads/order-type";
import { resolveOrCreateCustomerForLead } from "@/modules/leads/resolve-customer";
import { normalizeLeadPriority } from "@/modules/leads/status";
import { hashPassword } from "@/lib/auth/password";
import { validateProductUom } from "@/modules/uom/service";

type Tx = Prisma.TransactionClient;

function randomPortalPassword() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
  let password = "";
  for (let i = 0; i < 16; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

async function leadForSession(tx: Tx, leadId: string, session: SessionUser) {
  const plantIds = await plantIdsForSession(session);
  if (!plantIds.length) throw new AppError(404, "NOT_FOUND", "Lead not found.");
  const lead = await tx.lead.findFirst({ where: { id: leadId, plantId: { in: plantIds }, deletedAt: null } });
  if (!lead) throw new AppError(404, "NOT_FOUND", "Lead not found.");
  return lead;
}

export async function softDeleteLead(session: SessionUser, leadId: string, key: string | null) {
  allow(session, "lead.manage");
  return runCommand({
    userId: session.userId,
    route: "lead.delete",
    key,
    run: async (tx) => {
      const lead = await leadForSession(tx, leadId, session);
      const deletedAt = new Date();
      const changed = await tx.lead.updateMany({
        where: { id: leadId, plantId: lead.plantId, deletedAt: null },
        data: { deletedAt },
      });
      if (changed.count !== 1) throw new AppError(404, "NOT_FOUND", "Lead not found.");
      await audit(tx, { userId: session.userId, action: "lead.soft_delete", resource: "lead", resourceId: leadId });
      return { id: leadId, mode: "soft_deleted" as const };
    },
  });
}

export type LeadItemInput = {
  categoryId?: string;
  productId?: string;
  parentProductId?: string;
  productVariantId?: string;
  itemDescription?: string;
  quantity: string;
  unitId?: string;
  uom?: string;
  targetPrice?: string;
  marketPrice?: string;
  thickness?: string;
  grade?: string;
  size?: string;
  estimatedWeight?: string;
  priceOffered?: string;
  priceFinalised?: string;
  specifications?: Record<string, unknown>;
  notes?: string;
  mfgGrade?: string;
  gaugeThicknessMm?: string;
  weightPerPieceGrams?: string;
  finish?: string;
  sizeOrCapacity?: string;
  packing?: string;
  logoRequired?: boolean;
  artworkUrl?: string;
  pricingBasis?: string;
  inStock?: boolean;
  estimatedLeadTimeDays?: number;
  expectedDeliveryDate?: string;
  requiredDeliveryDate?: string;
  promisedDeliveryDate?: string;
};

function leadItemMfgData(line: LeadItemInput) {
  return {
    ...(line.mfgGrade?.trim() ? { mfgGrade: line.mfgGrade.trim() } : {}),
    ...(line.gaugeThicknessMm?.trim()
      ? { gaugeThicknessMm: new Decimal(line.gaugeThicknessMm) }
      : {}),
    ...(line.weightPerPieceGrams?.trim()
      ? { weightPerPieceGrams: new Decimal(line.weightPerPieceGrams) }
      : {}),
    ...(line.finish?.trim() ? { finish: line.finish.trim() } : {}),
    ...(line.sizeOrCapacity?.trim() ? { sizeOrCapacity: line.sizeOrCapacity.trim() } : {}),
    ...(line.packing?.trim() ? { packing: line.packing.trim() } : {}),
    logoRequired: Boolean(line.logoRequired),
    ...(line.artworkUrl?.trim() ? { artworkUrl: line.artworkUrl.trim() } : {}),
    ...(line.pricingBasis?.trim() ? { pricingBasis: line.pricingBasis.trim().toUpperCase() } : {}),
    ...(line.inStock != null ? { inStock: line.inStock } : {}),
    ...(line.estimatedLeadTimeDays != null ? { estimatedLeadTimeDays: line.estimatedLeadTimeDays } : {}),
  };
}

async function notifyAssignee(tx: Tx, plantId: string, assigneeId: string | null, leadId: string, leadNumber: string) {
  if (!assigneeId) return;
  const employee = await tx.employee.findUnique({ where: { id: assigneeId }, select: { userId: true } });
  if (!employee?.userId) return;
  await notifyUsers(tx, {
    userIds: [employee.userId],
    type: "lead.assigned",
    title: "Lead assigned to you",
    body: `${leadNumber} needs follow-up.`,
    href: `/leads/${leadId}`,
  });
}

const variantSelectForLead = {
  id: true,
  productId: true,
  materialMasterId: true,
  displayName: true,
  attributes: true,
  grade: true,
  finish: true,
  thicknessMm: true,
  widthMm: true,
  lengthMm: true,
  diameterMm: true,
  product: {
    select: {
      categoryId: true,
      sku: true,
      name: true,
      category: { select: { code: true } },
    },
  },
} as const;

async function createLeadItems(tx: Tx, leadId: string, plantId: string, items: LeadItemInput[]) {
  const variantIds = [...new Set(items.map((line) => line.productVariantId).filter((id): id is string => Boolean(id)))];
  const parentIds = [...new Set(items.map((line) => line.parentProductId).filter((id): id is string => Boolean(id)))];

  const [variants, parents] = await Promise.all([
    variantIds.length
      ? tx.productVariant.findMany({
          where: {
            id: { in: variantIds },
            plantId,
            isActive: true,
            product: { isActive: true },
          },
          select: variantSelectForLead,
        })
      : Promise.resolve([]),
    parentIds.length
      ? tx.product.findMany({
          where: { id: { in: parentIds } },
          select: { id: true, sku: true, name: true },
        })
      : Promise.resolve([]),
  ]);

  const variantById = new Map(variants.map((row) => [row.id, row]));
  const parentById = new Map(parents.map((row) => [row.id, row]));
  const uomCache = new Map<string, { unitId: string; uom: string }>();

  for (const line of items) {
    if (
      !line.productId &&
      !line.parentProductId &&
      !line.itemDescription?.trim() &&
      !line.thickness &&
      !line.grade &&
      !line.size
    ) {
      throw new AppError(400, "VALIDATION", "Each line needs a product, description, or specification.");
    }
    let parentProductId = line.parentProductId;
    if (parentProductId) {
      const parentProduct = parentById.get(parentProductId);
      if (!parentProduct) {
        const fetched = await tx.product.findUnique({
          where: { id: parentProductId },
          select: { id: true, sku: true, name: true },
        });
        if (fetched) parentById.set(fetched.id, fetched);
      }
      if (isProductComingSoon(parentById.get(parentProductId) ?? null)) {
        throw new AppError(400, "VALIDATION", "Semi Finish Utensils is coming soon and cannot be requested yet.");
      }
    }
    if (line.productVariantId) {
      const variant = variantById.get(line.productVariantId);
      if (!variant) {
        throw new AppError(400, "VALIDATION", "Choose an active variant that belongs to the selected parent product.");
      }
      if (
        !line.productId ||
        line.productId !== (variant.materialMasterId ?? variant.id) ||
        (parentProductId && parentProductId !== variant.productId)
      ) {
        throw new AppError(400, "VALIDATION", "Choose an active variant that belongs to the selected parent product.");
      }
      if (isProductComingSoon(variant.product)) {
        throw new AppError(400, "VALIDATION", "Semi Finish Utensils is coming soon and cannot be requested yet.");
      }
      parentProductId = variant.productId;
      const variantSpecs = variant.attributes && typeof variant.attributes === "object" && !Array.isArray(variant.attributes) ? variant.attributes as Record<string, unknown> : {};
      const isManufacturedCircle =
        variant.product.category?.code === "MFG" &&
        (variant.product.sku.trim().toUpperCase() === "CIRCLE" ||
          variant.product.name.trim().toLowerCase() === "circle");
      const savedVariantSpecs = isManufacturedCircle
        ? Object.fromEntries(
            Object.entries(variantSpecs).filter(
              ([key]) => !/^edge(?:[_\s-]?type)?$/i.test(key),
            ),
          )
        : variantSpecs;
      const formSpecs: Record<string, string> = {};
      for (const [key, value] of Object.entries(line.specifications ?? {})) {
        if (value == null || typeof value === "object") continue;
        const text = String(value).trim();
        if (text) formSpecs[key] = text;
      }
      if (line.grade?.trim()) formSpecs.grade = line.grade.trim();
      if (line.thickness?.trim()) formSpecs.thickness = line.thickness.trim();

      const config = resolveProductFieldConfig(variant.product);
      const flatVariant = flattenVariantSpecs({
        grade: variant.grade,
        finish: variant.finish,
        thicknessMm: variant.thicknessMm?.toString() ?? null,
        widthMm: variant.widthMm?.toString() ?? null,
        lengthMm: variant.lengthMm?.toString() ?? null,
        diameterMm: variant.diameterMm?.toString() ?? null,
        attributes: savedVariantSpecs,
      });
      const match = resolveExactPricedVariant(
        [{ id: variant.id, materialMasterId: variant.materialMasterId, specs: flatVariant }],
        formSpecs,
        config,
      );
      if (match.status === "ambiguous") {
        throw new AppError(409, "DUPLICATE", RATE_AMBIGUOUS_MESSAGE);
      }
      if (match.status !== "exact" || match.variant?.id !== variant.id) {
        throw new AppError(400, "VALIDATION", RATE_PENDING_MESSAGE);
      }
      line.specifications = {
        ...savedVariantSpecs,
        grade: formSpecs.grade ?? variant.grade ?? savedVariantSpecs.grade,
        finish: formSpecs.finish ?? variant.finish ?? savedVariantSpecs.finish,
        thickness:
          formSpecs.thickness ??
          variant.thicknessMm?.toString() ??
          savedVariantSpecs.thickness,
        width: formSpecs.width ?? variant.widthMm?.toString() ?? savedVariantSpecs.width,
        length: formSpecs.length ?? variant.lengthMm?.toString() ?? savedVariantSpecs.length,
        diameter:
          formSpecs.diameter ?? variant.diameterMm?.toString() ?? savedVariantSpecs.diameter,
        ...formSpecs,
        variantDisplayName: variant.displayName ?? undefined,
      };
    } else if (parentProductId) {
      // Price-pending lead items are allowed: store parent + specs without a catalog rate.
      const parent = parentById.get(parentProductId);
      const formSpecs: Record<string, string> = {};
      for (const [key, value] of Object.entries(line.specifications ?? {})) {
        if (value == null || typeof value === "object") continue;
        const text = String(value).trim();
        if (text) formSpecs[key] = text;
      }
      if (line.grade?.trim()) formSpecs.grade = line.grade.trim();
      if (line.thickness?.trim()) formSpecs.thickness = line.thickness.trim();
      if (line.finish?.trim()) formSpecs.finish = line.finish.trim();
      line.specifications = {
        ...formSpecs,
        ratePending: true,
      };
      if (!line.itemDescription?.trim() && parent?.name) {
        line.itemDescription = parent.name;
      }
      line.productId = undefined;
      line.productVariantId = undefined;
      line.targetPrice = undefined;
      line.marketPrice = undefined;
      line.priceOffered = undefined;
    }
    const specs = {
      ...(line.specifications ?? {}),
      ...(line.categoryId ? { categoryId: line.categoryId } : {}),
      ...(line.thickness ? { thickness: line.thickness } : {}),
      ...(line.grade ? { grade: line.grade } : {}),
      ...(line.size ? { size: line.size } : {}),
    };
    let unitId = line.unitId ?? null;
    let uom = line.uom?.trim() || "PCS";
    if (parentProductId) {
      const cacheKey = `${parentProductId}:${unitId ?? ""}:${uom.toUpperCase()}`;
      const cached = uomCache.get(cacheKey);
      if (cached) {
        unitId = cached.unitId;
        uom = cached.uom;
      } else {
        const validated = await validateProductUom(
          parentProductId,
          plantId,
          { unitId, uomSymbol: uom },
          tx,
        );
        unitId = validated.unit.id;
        uom = validated.unit.symbol;
        uomCache.set(cacheKey, { unitId, uom });
      }
    }
    const createdItem = await tx.leadItem.create({
      data: {
        id: uuidv7(),
        leadId,
        productId: line.productId ?? null,
        parentProductId: parentProductId ?? null,
        productVariantId: line.productVariantId ?? null,
        itemDescription: line.itemDescription?.trim() || (line.productId ? null : "Requested material"),
        quantity: line.quantity,
        unitId,
        uom,
        targetPrice: line.targetPrice ?? null,
        marketPrice: line.marketPrice
          ? new Decimal(line.marketPrice)
          : line.targetPrice
            ? new Decimal(line.targetPrice)
            : null,
        priceOffered: line.priceOffered ? new Decimal(line.priceOffered) : null,
        priceFinalised: line.priceFinalised ? new Decimal(line.priceFinalised) : null,
        estimatedWeight: line.estimatedWeight ? new Decimal(line.estimatedWeight) : null,
        ...leadItemMfgData(line),
        requiredDeliveryDate: line.requiredDeliveryDate?.trim()
          ? new Date(line.requiredDeliveryDate.trim())
          : null,
        promisedDeliveryDate: line.promisedDeliveryDate?.trim()
          ? new Date(line.promisedDeliveryDate.trim())
          : null,
        // Keep expectedDeliveryDate in sync with required for quotations / legacy UI.
        expectedDeliveryDate: (line.requiredDeliveryDate?.trim() || line.expectedDeliveryDate?.trim())
          ? new Date((line.requiredDeliveryDate?.trim() || line.expectedDeliveryDate!.trim()))
          : null,
        specifications: specs as object,
        notes: line.notes ?? null,
      },
    });

    const designFileIds = extractDesignFileIds(line.specifications as Record<string, unknown> | undefined);
    if (designFileIds.length > 0) {
      await tx.leadDesignFile.updateMany({
        where: { id: { in: designFileIds }, plantId },
        data: { leadItemId: createdItem.id },
      });
    }
  }
}

export async function createLeadManual(
  session: SessionUser,
  input: {
    queryDate?: string;
    queryTime?: string;
    contactPerson?: string;
    contactDesignation?: string;
    address?: string;
    customerName: string;
    email?: string;
    phone: string;
    companyName?: string;
    customerId?: string;
    source: LeadSource;
    priority?: string;
    assigneeId?: string;
    nextFollowUpAt?: string;
    notes?: string;
    requiredDeliveryDate?: string;
    promisedDeliveryDate?: string;
    attendedById?: string;
    result?: string;
    resultReason?: string;
    officeRemarks?: string;
    gstin?: string;
    orderType?: string;
    items: LeadItemInput[];
  },
  key: string | null,
) {
  allow(session, "lead.manage");
  const plantId = primaryPlant(session);
  // Hash outside the command transaction — argon2 must not hold a DB connection open.
  const needsPortalUser = !input.customerId && Boolean(input.email?.trim());
  const portalPasswordHash = needsPortalUser
    ? await hashPassword(randomPortalPassword())
    : undefined;
  return runCommand({
    userId: session.userId,
    route: "lead.create",
    key,
    run: async (tx) => {
      if (input.assigneeId) {
        const emp = await tx.employee.findFirst({ where: { id: input.assigneeId, plantId } });
        if (!emp) throw new AppError(400, "VALIDATION", "Assignee not found.");
      }
      if (input.attendedById) {
        const emp = await tx.employee.findFirst({ where: { id: input.attendedById, plantId } });
        if (!emp) throw new AppError(400, "VALIDATION", "Attended by employee not found.");
      }
      if (input.result === "FAILURE" && !input.resultReason?.trim()) {
        throw new AppError(400, "VALIDATION", "Provide a reason for unsuccessful query.");
      }
      if (!isValidGstin(input.gstin)) {
        throw new AppError(400, "VALIDATION", "Enter a valid 15-character GSTIN.");
      }
      // Same customer may have many leads / sales orders — no duplicate soft-block on create.
      const customerName = input.contactPerson?.trim() || input.customerName.trim();
      const customerId = await resolveOrCreateCustomerForLead(
        tx,
        plantId,
        {
          customerId: input.customerId,
          name: input.companyName?.trim() || customerName,
          phone: input.phone,
          email: input.email,
          portalPasswordHash,
        },
        session.userId,
      );
      const itemRequiredDates = input.items
        .map((line) => line.requiredDeliveryDate?.trim())
        .filter((value): value is string => Boolean(value))
        .sort();
      const itemPromisedDates = input.items
        .map((line) => line.promisedDeliveryDate?.trim())
        .filter((value): value is string => Boolean(value))
        .sort();
      // Lead-level dates = earliest per-product dates (used on convert / summary).
      const requiredDeliveryDate =
        input.requiredDeliveryDate?.trim() || itemRequiredDates[0] || undefined;
      const promisedDeliveryDate =
        input.promisedDeliveryDate?.trim() || itemPromisedDates[0] || undefined;
      const priority = normalizeLeadPriority(input.priority);
      const leadNumber = await nextNumber(tx, plantId, "LD");
      const id = uuidv7();
      await tx.lead.create({
        data: {
          id,
          plantId,
          leadNumber,
          customerName,
          email: input.email?.trim() || null,
          ...leadIdentityPatch({
            phone: input.phone,
            email: input.email,
            gstin: input.gstin,
          }),
          companyName: input.companyName?.trim() || null,
          customerId,
          source: input.source,
          orderType: normalizeLeadOrderType(input.orderType),
          status: "NEW",
          priority,
          assigneeId: input.assigneeId ?? null,
          nextFollowUpAt: input.nextFollowUpAt ? new Date(input.nextFollowUpAt) : null,
          notes: input.notes ?? null,
          queryDate: input.queryDate ? new Date(input.queryDate) : null,
          queryTime: (() => {
            if (!input.queryTime) return null;
            const parsed = new Date(
              input.queryTime.includes("T") ? input.queryTime : `${input.queryDate ?? ""}T${input.queryTime}`,
            );
            return Number.isNaN(parsed.getTime()) ? null : parsed;
          })(),
          contactPerson: input.contactPerson?.trim() || null,
          contactDesignation: input.contactDesignation?.trim() || null,
          address: input.address?.trim() || null,
          attendedById: input.attendedById ?? null,
          officeRemarks: input.officeRemarks ?? null,
          requiredDeliveryDate: requiredDeliveryDate ? new Date(requiredDeliveryDate) : null,
          promisedDeliveryDate: promisedDeliveryDate ? new Date(promisedDeliveryDate) : null,
          result: input.result ?? "PENDING",
          resultReason: input.resultReason?.trim() || null,
          createdById: session.userId,
          lastActivityAt: new Date(),
        },
      });
      await createLeadItems(tx, id, plantId, input.items);
      // Lead row already has status/lastActivityAt/nextFollowUpAt from create.
      await recordLeadStatus(tx, id, session.userId, null, "NEW", "Lead created", {
        skipLeadUpdate: true,
      });
      await addLeadActivity(tx, {
        leadId: id,
        userId: session.userId,
        activityType: "created",
        description: `Lead created (${input.source}).`,
        nextFollowUpAt: input.nextFollowUpAt ? new Date(input.nextFollowUpAt) : null,
        skipLeadUpdate: true,
      });
      await notifyAssignee(tx, plantId, input.assigneeId ?? null, id, leadNumber);
      await audit(tx, { userId: session.userId, action: "lead.create", resource: "lead", resourceId: id });
      return { id, leadNumber };
    },
  });
}

export async function changeLeadStatus(
  session: SessionUser,
  leadId: string,
  input: {
    status: LeadStatus;
    reason?: string;
    lostReasonCode?: string;
    lostReasonNote?: string;
    competitorName?: string;
    competitorRate?: string;
    customerTargetRate?: string;
    nextFollowUpAt?: string;
  },
  key: string | null,
) {
  allow(session, "lead.manage");
  return runCommand({
    userId: session.userId,
    route: "lead.status",
    key,
    run: async (tx) => {
      const lead = await leadForSession(tx, leadId, session);
      if (lead.status === "CONVERTED") throw new AppError(409, "INVALID_STATE", "Converted leads cannot change status.");
      if (input.status === "VERIFIED" || input.status === "CONVERTED") {
        throw new AppError(409, "INVALID_STATE", "Use the dedicated verification or conversion action for this status.");
      }
      const lostNote = (input.lostReasonNote ?? input.reason ?? "").trim();
      if (leadRequiresLostReason(input.status) && !input.lostReasonCode?.trim()) {
        throw new AppError(400, "VALIDATION", "Select a structured reason for lost/rejected leads.");
      }
      if (
        leadRequiresLostReason(input.status) &&
        input.lostReasonCode?.trim().toUpperCase() === "OTHER" &&
        !lostNote
      ) {
        throw new AppError(400, "VALIDATION", "Provide details when reason is Other.");
      }
      const followUpAt = parseFollowUpAt(input.nextFollowUpAt);
      try {
        assertNextFollowUpForStatus(input.status, followUpAt);
      } catch {
        throw new AppError(
          400,
          "VALIDATION",
          "Set next follow-up date/time when moving to Contacted, Follow-up, Quotation sent, or Negotiation.",
        );
      }
      const sameStatus = lead.status === input.status;
      if (!sameStatus) {
        const transitionCtx = { orderType: lead.orderType };
        try {
          assertLeadTransition(lead.status, input.status, transitionCtx);
        } catch (error) {
          const message =
            error instanceof Error && error.message.includes("CUSTOM_REQUIRED")
              ? "Sample approval is only available for custom-order leads."
              : `Cannot move from ${lead.status} to ${input.status}.`;
          throw new AppError(409, "INVALID_TRANSITION", message);
        }
      } else if (!followUpAt && !input.lostReasonNote?.trim() && !input.reason?.trim()) {
        return { id: leadId, status: input.status };
      }
      const now = new Date();
      const lostCode = input.lostReasonCode?.trim().toUpperCase();
      const negotiationRates =
        input.status === "NEGOTIATION" || lead.status === "NEGOTIATION"
          ? {
              ...(input.competitorName !== undefined
                ? { competitorName: input.competitorName.trim() || null }
                : {}),
              ...(input.competitorRate !== undefined
                ? {
                    competitorRate: input.competitorRate.trim()
                      ? new Decimal(input.competitorRate.trim())
                      : null,
                  }
                : {}),
              ...(input.customerTargetRate !== undefined
                ? {
                    customerTargetRate: input.customerTargetRate.trim()
                      ? new Decimal(input.customerTargetRate.trim())
                      : null,
                  }
                : {}),
            }
          : {};
      const changed = await tx.lead.updateMany({
        where: { id: leadId, status: lead.status, salesOrderId: null },
        data: {
          status: input.status,
          lastActivityAt: now,
          ...(followUpAt ? { nextFollowUpAt: followUpAt } : {}),
          ...(!sameStatus ? firstContactMetrics(lead, input.status, now) : {}),
          ...negotiationRates,
          ...(leadRequiresLostReason(input.status) && lostCode
            ? {
                lostReasonCode: lostCode,
                lostReasonNote: lostNote || null,
                lostReason: formatLostReasonLegacyColumn(lostCode, lostNote),
                ...(input.status === "LOST"
                  ? {
                      ...(input.competitorName !== undefined
                        ? { competitorName: input.competitorName.trim() || null }
                        : {}),
                      ...(input.competitorRate !== undefined
                        ? {
                            competitorRate: input.competitorRate.trim()
                              ? new Decimal(input.competitorRate.trim())
                              : null,
                          }
                        : {}),
                    }
                  : {}),
              }
            : {}),
        },
      });
      if (changed.count !== 1) {
        throw new AppError(409, "INVALID_STATE", "The lead changed while you were updating it. Refresh and try again.");
      }
      const historyReason = lostCode
        ? formatLostReasonLegacyColumn(lostCode, lostNote)
        : input.reason?.trim() || lostNote || undefined;
      if (!sameStatus) {
        await recordLeadStatus(tx, leadId, session.userId, lead.status, input.status, historyReason, {
          skipLeadUpdate: true,
        });
      }
      await addLeadActivity(tx, {
        leadId,
        userId: session.userId,
        activityType: sameStatus ? "follow_up" : "status",
        description: sameStatus
          ? `Follow-up updated${followUpAt ? ` · next ${followUpAt.toISOString()}` : ""}${historyReason ? `: ${historyReason}` : ""}`
          : `Status → ${input.status}${historyReason ? `: ${historyReason}` : ""}`,
        nextFollowUpAt: followUpAt,
        skipLeadUpdate: true,
      });
      return {
        id: leadId,
        status: input.status,
        emailLead: sameStatus
          ? null
          : {
              id: lead.id,
              plantId: lead.plantId,
              leadNumber: lead.leadNumber,
              customerName: lead.customerName,
              email: lead.email,
            },
      };
    },
  }).then(async (result) => {
    if (result.emailLead?.email) {
      await notifyLeadStatusEmail(result.emailLead, result.status as LeadStatus);
    }
    return { id: result.id, status: result.status };
  });
}

export async function updateLeadNegotiation(
  session: SessionUser,
  leadId: string,
  input: { competitorName?: string; competitorRate?: string; customerTargetRate?: string },
  key: string | null,
) {
  allow(session, "lead.manage");
  return runCommand({
    userId: session.userId,
    route: "lead.negotiation",
    key,
    run: async (tx) => {
      const lead = await leadForSession(tx, leadId, session);
      if (!["NEGOTIATION", "QUOTATION_SENT"].includes(lead.status)) {
        throw new AppError(
          409,
          "INVALID_STATE",
          "Competitor intelligence can only be updated during quotation or negotiation.",
        );
      }
      await tx.lead.update({
        where: { id: leadId },
        data: {
          competitorName: input.competitorName?.trim() || null,
          competitorRate: input.competitorRate?.trim()
            ? new Decimal(input.competitorRate.trim())
            : null,
          customerTargetRate: input.customerTargetRate?.trim()
            ? new Decimal(input.customerTargetRate.trim())
            : null,
          lastActivityAt: new Date(),
        },
      });
      await addLeadActivity(tx, {
        leadId,
        userId: session.userId,
        activityType: "negotiation",
        description: "Updated competitor / target rate intelligence.",
      });
      return { id: leadId };
    },
  });
}

export async function assignLead(
  session: SessionUser,
  leadId: string,
  input: { assigneeId: string | null },
  key: string | null,
) {
  allow(session, "lead.manage");
  return runCommand({
    userId: session.userId,
    route: "lead.assign",
    key,
    run: async (tx) => {
      const lead = await leadForSession(tx, leadId, session);
      const plantId = lead.plantId;
      if (lead.status === "CONVERTED") throw new AppError(409, "INVALID_STATE", "Lead already converted.");
      if (input.assigneeId) {
        const emp = await tx.employee.findFirst({ where: { id: input.assigneeId, plantId } });
        if (!emp) throw new AppError(400, "VALIDATION", "Employee not found.");
      }
      await tx.lead.update({ where: { id: leadId }, data: { assigneeId: input.assigneeId } });
      await addLeadActivity(tx, {
        leadId,
        userId: session.userId,
        activityType: "assignment",
        description: input.assigneeId ? "Lead reassigned." : "Lead unassigned.",
      });
      await notifyAssignee(tx, plantId, input.assigneeId, leadId, lead.leadNumber);
      return { id: leadId };
    },
  });
}

export async function verifyLead(
  session: SessionUser,
  leadId: string,
  input: {
    checks: {
      quantityConfirmed: true;
    };
    verificationNotes?: string;
  },
  key: string | null,
) {
  allow(session, "lead.verify");
  return runCommand({
    userId: session.userId,
    route: "lead.verify",
    key,
    run: async (tx) => {
      const lead = await leadForSession(tx, leadId, session);
      if (!leadCanVerify(lead.status)) {
        throw new AppError(409, "INVALID_STATE", "Lead is not ready for verification.");
      }
      if (!input.checks.quantityConfirmed) {
        throw new AppError(400, "VALIDATION", "Confirm quantity and UOM before qualifying the lead.");
      }
      const metadata = await tx.lead.updateMany({
        where: { id: leadId, status: lead.status, salesOrderId: null },
        data: {
          status: "VERIFIED",
          verificationNotes: input.verificationNotes?.trim() || null,
          verifiedById: session.userId,
          verifiedAt: new Date(),
          lastActivityAt: new Date(),
        },
      });
      if (metadata.count !== 1) {
        throw new AppError(409, "INVALID_STATE", "The lead changed while you were verifying it. Refresh and try again.");
      }
      await recordLeadStatus(
        tx,
        leadId,
        session.userId,
        lead.status,
        "VERIFIED",
        "Verification checks completed",
        { skipLeadUpdate: true },
      );
      await addLeadActivity(tx, {
        leadId,
        userId: session.userId,
        activityType: "verification",
        description: input.verificationNotes?.trim() || "Customer, requested items, quantity, and requirement confirmed.",
        skipLeadUpdate: true,
      });
      return {
        id: leadId,
        status: "VERIFIED" as const,
        emailLead: {
          id: lead.id,
          plantId: lead.plantId,
          leadNumber: lead.leadNumber,
          customerName: lead.customerName,
          email: lead.email,
        },
      };
    },
  }).then(async (result) => {
    if (result.emailLead?.email) {
      await notifyLeadStatusEmail(result.emailLead, result.status);
    }
    return { id: result.id, status: result.status };
  });
}

export async function convertLeadToSalesOrder(
  session: SessionUser,
  leadId: string,
  input: {
    promisedDate?: string;
    expectedDispatchDate?: string;
    poNumber?: string;
    poAttachmentUrl?: string;
    advanceAmount?: string;
    quotationId?: string;
    lines: {
      leadItemId: string;
      productId?: string;
      unitPrice?: string;
      inStock?: boolean;
      estimatedLeadTimeDays?: number;
    }[];
  },
  key: string | null,
) {
  allow(session, "lead.convert");
  return runCommand({
    userId: session.userId,
    route: "lead.convert",
    key,
    run: async (tx) => {
      const plantIds = await plantIdsForSession(session);
      const lead = await tx.lead.findFirst({
        where: { id: leadId, plantId: { in: plantIds }, deletedAt: null },
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                  code: true,
                  taxRate: true,
                  salesUom: true,
                  uom: true,
                },
              },
            },
          },
          customer: { select: { id: true, name: true, phone: true, repeatOrderFollowUpDays: true } },
          salesOrder: { select: { id: true, number: true } },
        },
      });
      if (!lead) throw new AppError(404, "NOT_FOUND", "Lead not found.");
      const plantId = lead.plantId;
      if (lead.salesOrderId && lead.salesOrder) {
        return {
          leadId,
          salesOrderId: lead.salesOrder.id,
          number: lead.salesOrder.number,
          plantId,
          leadNumber: lead.leadNumber,
          customerName: lead.customerName,
          email: null,
        };
      }
      if (!leadCanConvert(lead.status)) {
        throw new AppError(
          409,
          "INVALID_STATE",
          "Lead must be qualified, quotation sent, or in negotiation before conversion.",
        );
      }
      if (!lead.items.length) throw new AppError(400, "VALIDATION", "This lead has no requested items to convert.");
      if (input.lines.length !== lead.items.length || new Set(input.lines.map((line) => line.leadItemId)).size !== lead.items.length) {
        throw new AppError(400, "VALIDATION", "Review every requested lead item before creating the sales order.");
      }

      if (!input.quotationId?.trim()) {
        throw new AppError(
          400,
          "VALIDATION",
          "Select an approved, sent quotation before creating the sales order.",
        );
      }
      const quote = await tx.quotation.findFirst({
        where: { id: input.quotationId.trim(), leadId, plantId },
        include: { items: true },
      });
      if (!quote) throw new AppError(404, "NOT_FOUND", "Selected quotation was not found.");
      if (!quotationCanAcceptOnConvert(quote.status)) {
        throw new AppError(409, "INVALID_STATE", "Quotation must be sent (or already accepted) to convert.");
      }
      if (!quote.approvedAt) {
        throw new AppError(
          409,
          "APPROVAL_REQUIRED",
          "Quotation pricing was not approved before it was sent. Revise and re-approve, or contact admin.",
        );
      }
      const quotedLeadItemIds = new Set(
        quote.items.map((row) => row.leadItemId).filter((id): id is string => Boolean(id)),
      );
      const missingItems = lead.items.filter((item) => !quotedLeadItemIds.has(item.id));
      if (missingItems.length) {
        throw new AppError(
          400,
          "VALIDATION",
          "The quotation must include every requested lead item before conversion.",
        );
      }
      const acceptedQuotationId = quote.id;
      const quotationItemsByLeadItem = new Map(
        quote.items
          .filter((row) => row.leadItemId)
          .map((row) => [
            row.leadItemId!,
            {
              productId: row.productId,
              rate: row.rate.toString(),
              pricingBasis: row.pricingBasis,
            },
          ]),
      );

      const resolvedProductIds = [
        ...new Set(
          lead.items
            .map((item) => {
              const selection = input.lines.find((line) => line.leadItemId === item.id);
              const quoted = quotationItemsByLeadItem.get(item.id);
              return selection?.productId ?? quoted?.productId ?? item.productId ?? null;
            })
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      const products = resolvedProductIds.length
        ? await tx.materialMaster.findMany({
            where: {
              id: { in: resolvedProductIds },
              plantId,
              active: true,
              salesAllowed: true,
            },
            select: {
              id: true,
              taxRate: true,
              salesUom: true,
              uom: true,
            },
          })
        : [];
      const productById = new Map(products.map((row) => [row.id, row]));

      const orderLines = [];
      for (const item of lead.items) {
        const selection = input.lines.find((line) => line.leadItemId === item.id);
        const quoted = quotationItemsByLeadItem.get(item.id);
        const productId = selection?.productId ?? quoted?.productId ?? item.productId;
        if (!productId) throw new AppError(400, "VALIDATION", `Select a sales product for ${item.itemDescription || "each requested item"}.`);
        const product = productById.get(productId);
        if (!product) throw new AppError(400, "VALIDATION", "Select an active sales product for every requested item.");
        const specifications = item.specifications && typeof item.specifications === "object" && !Array.isArray(item.specifications)
          ? item.specifications as Record<string, unknown>
          : {};
        const inStock = selection?.inStock ?? item.inStock ?? null;
        const leadTimeDays = selection?.estimatedLeadTimeDays ?? item.estimatedLeadTimeDays ?? null;
        if (inStock != null || leadTimeDays != null) {
          await tx.leadItem.update({
            where: { id: item.id },
            data: {
              ...(inStock != null ? { inStock } : {}),
              ...(leadTimeDays != null ? { estimatedLeadTimeDays: leadTimeDays } : {}),
            },
          });
        }
        const quotedRate = quoted?.rate;
        if (!quotedRate) {
          throw new AppError(
            400,
            "VALIDATION",
            `Missing approved offer rate on quotation for ${item.itemDescription || "a requested item"}.`,
          );
        }
        if (selection?.unitPrice?.trim() && selection.unitPrice.trim() !== quotedRate) {
          throw new AppError(
            400,
            "VALIDATION",
            "Unit price must match the approved quotation; change the quote instead.",
          );
        }
        orderLines.push({
          productId: product.id,
          qtyOrdered: item.quantity.toString(),
          unitPrice: quotedRate,
          taxPct: product.taxRate?.toString() || "0",
          uom: item.uom || product.salesUom || product.uom,
          specs: {
            ...specifications,
            ...(item.itemDescription ? { leadItemDescription: item.itemDescription } : {}),
            ...(item.estimatedWeight ? { estimatedWeight: item.estimatedWeight.toString() } : {}),
            ...(item.notes ? { leadItemNotes: item.notes } : {}),
            ...(item.mfgGrade ? { mfgGrade: item.mfgGrade } : {}),
            ...(quoted?.pricingBasis ? { pricingBasis: quoted.pricingBasis } : {}),
            ...(item.pricingBasis ? { pricingBasis: item.pricingBasis } : {}),
            ...(acceptedQuotationId ? { quotationId: acceptedQuotationId } : {}),
            ...(inStock != null ? { inStock } : {}),
            ...(leadTimeDays != null ? { estimatedLeadTimeDays: leadTimeDays } : {}),
            leadItemId: item.id,
            leadId: lead.id,
            leadNumber: lead.leadNumber,
            parentProductId: item.parentProductId,
            productVariantId: item.productVariantId,
          },
        });
      }

      const orderId = uuidv7();
      const claimed = await tx.lead.updateMany({
        where: { id: leadId, plantId, status: lead.status, salesOrderId: null, deletedAt: null },
        data: { convertedAt: new Date(), convertedById: session.userId, status: "CONVERTED" },
      });
      if (claimed.count !== 1) {
        const existing = await tx.lead.findUnique({ where: { id: leadId }, include: { salesOrder: true } });
        if (existing?.salesOrder) {
          return {
            leadId,
            salesOrderId: existing.salesOrder.id,
            number: existing.salesOrder.number,
            plantId,
            leadNumber: lead.leadNumber,
            customerName: lead.customerName,
            email: null,
          };
        }
        throw new AppError(409, "INVALID_STATE", "The lead changed while the order was being created. Refresh and try again.");
      }

      let customerId = lead.customerId;
      if (!customerId) {
        const customer = await tx.customer.findFirst({
          where: { plantId, OR: [
            { phone: { equals: lead.phone, mode: "insensitive" } },
            { name: { equals: lead.companyName || lead.customerName, mode: "insensitive" } },
          ] },
        });
        const resolved = customer ?? await createCustomerInTx(tx, plantId, { name: lead.companyName || lead.customerName, phone: lead.phone }, session.userId);
        customerId = resolved.id;
        await tx.lead.update({ where: { id: leadId }, data: { customerId } });
      }

      const number = await nextNumber(tx, plantId, "SO");
      await tx.salesOrder.create({
        data: {
          id: orderId,
          plantId,
          customerId,
          number,
          status: "draft",
          priority: lead.priority,
          requiredDeliveryDate: lead.requiredDeliveryDate,
          promisedDate: input.promisedDate
            ? new Date(input.promisedDate)
            : (lead.promisedDeliveryDate ?? null),
          expectedDispatchDate: input.expectedDispatchDate
            ? new Date(input.expectedDispatchDate)
            : null,
          poNumber: input.poNumber?.trim() || null,
          poAttachmentUrl: input.poAttachmentUrl?.trim() || null,
          advanceAmount: input.advanceAmount?.trim()
            ? new Decimal(input.advanceAmount.trim())
            : null,
          quotationId: acceptedQuotationId,
          notes: [lead.notes, lead.officeRemarks].filter(Boolean).join("\n\n") || null,
          items: {
            create: orderLines.map((line) => ({
              id: uuidv7(),
              productId: line.productId,
              qtyOrdered: line.qtyOrdered,
              unitPrice: line.unitPrice,
              taxPct: line.taxPct,
              discountPct: "0",
              uom: line.uom,
              specs: line.specs as object,
            })),
          },
        },
      });
      await tx.lead.update({ where: { id: leadId }, data: { salesOrderId: orderId, customerId } });
      await tx.salesOrderStatusEvent.create({
        data: {
          id: uuidv7(),
          orderId,
          fromStatus: null,
          toStatus: "draft",
          remarks: `Created from lead ${lead.leadNumber}`,
          userId: session.userId,
        },
      });

      if (acceptedQuotationId) {
        await markQuotationAccepted(tx, acceptedQuotationId, session.userId);
      }

      await recordLeadStatus(
        tx,
        leadId,
        session.userId,
        lead.status,
        "CONVERTED",
        `Sales order ${number}`,
        { skipLeadUpdate: true },
      );
      await addLeadActivity(tx, {
        leadId,
        userId: session.userId,
        activityType: "conversion",
        description: `Converted to sales order ${number}.`,
        skipLeadUpdate: true,
      });

      const repeatDays = resolveRepeatOrderFollowUpDays({
        leadDays: lead.repeatOrderFollowUpDays,
        customerDays: lead.customer?.repeatOrderFollowUpDays ?? null,
      });
      const repeatAt = addCalendarDays(new Date(), repeatDays);
      await tx.lead.update({
        where: { id: leadId },
        data: {
          repeatOrderFollowUpDays: repeatDays,
          repeatOrderFollowUpAt: repeatAt,
          lastActivityAt: new Date(),
          nextFollowUpAt: repeatAt,
        },
      });
      await addLeadActivity(tx, {
        leadId,
        userId: session.userId,
        activityType: "repeat_order_follow_up",
        description: `Repeat order follow-up scheduled in ${repeatDays} days.`,
        nextFollowUpAt: repeatAt,
        skipLeadUpdate: true,
      });

      await audit(tx, {
        userId: session.userId,
        action: "lead.convert",
        resource: "lead",
        resourceId: leadId,
        payload: { salesOrderId: orderId, number },
      });
      return {
        leadId,
        salesOrderId: orderId,
        number,
        plantId,
        leadNumber: lead.leadNumber,
        customerName: lead.customerName,
        email: lead.email,
      };
    },
  }).then(async (result) => {
    const toEmail = result.email?.trim();
    if (toEmail) {
      await notifyLeadByEmail({
        plantId: result.plantId,
        leadId: result.leadId,
        toEmail,
        subject: leadEmailSubject(result.leadNumber, "converted to order"),
        message: `Dear ${result.customerName},\n\nThank you — your enquiry ${result.leadNumber} is now sales order ${result.number}. We will confirm shortly.\n\nRegards,\nSS Metals`,
      });
    }
    return { leadId: result.leadId, salesOrderId: result.salesOrderId, number: result.number };
  });
}

export async function addLeadActivityManual(
  session: SessionUser,
  leadId: string,
  input: { activityType: string; description: string; nextFollowUpAt?: string },
  key: string | null,
) {
  allow(session, "lead.manage");
  return runCommand({
    userId: session.userId,
    route: "lead.activity",
    key,
    run: async (tx) => {
      await leadForSession(tx, leadId, session);
      await addLeadActivity(tx, {
        leadId,
        userId: session.userId,
        activityType: input.activityType,
        description: input.description.trim(),
        nextFollowUpAt: input.nextFollowUpAt ? new Date(input.nextFollowUpAt) : null,
      });
      return { id: leadId };
    },
  });
}

export type LeadItemPatchInput = {
  id: string;
  itemDescription?: string | null;
  quantity: string;
  uom?: string;
  grade?: string | null;
  thickness?: string | null;
  finish?: string | null;
  packing?: string | null;
  width?: string | null;
  length?: string | null;
  diameter?: string | null;
  notes?: string | null;
  requiredDeliveryDate?: string | null;
  promisedDeliveryDate?: string | null;
};

function parseOptionalDate(value: string | null | undefined) {
  if (value === undefined) return undefined;
  if (value == null || !String(value).trim()) return null;
  return new Date(String(value).trim());
}

function setOrClearSpec(specs: Record<string, unknown>, key: string, value: string | null | undefined) {
  if (value === undefined) return;
  const trimmed = value?.trim() ?? "";
  if (!trimmed) delete specs[key];
  else specs[key] = trimmed;
}

/** Update requested items while official follow-up result is still PENDING. */
export async function updateLeadItems(
  session: SessionUser,
  leadId: string,
  input: { items: LeadItemPatchInput[] },
  key: string | null,
) {
  allow(session, "lead.manage");
  return runCommand({
    userId: session.userId,
    route: "lead.items",
    key,
    run: async (tx) => {
      const lead = await leadForSession(tx, leadId, session);
      if (lead.status === "CONVERTED" || lead.salesOrderId) {
        throw new AppError(409, "INVALID_STATE", "Converted leads cannot change requested items.");
      }
      if ((lead.result ?? "PENDING").toUpperCase() !== "PENDING") {
        throw new AppError(
          409,
          "INVALID_STATE",
          "Requested items can only be edited while official follow-up is Pending.",
        );
      }

      const existingItems = await tx.leadItem.findMany({ where: { leadId } });
      const byId = new Map(existingItems.map((row) => [row.id, row]));
      if (!input.items.length) {
        throw new AppError(400, "VALIDATION", "Provide at least one lead item to update.");
      }
      for (const line of input.items) {
        if (!byId.has(line.id)) {
          throw new AppError(400, "VALIDATION", "One or more lead items do not belong to this lead.");
        }
      }

      for (const line of input.items) {
        const current = byId.get(line.id)!;
        const specs =
          current.specifications &&
          typeof current.specifications === "object" &&
          !Array.isArray(current.specifications)
            ? { ...(current.specifications as Record<string, unknown>) }
            : {};

        setOrClearSpec(specs, "grade", line.grade);
        setOrClearSpec(specs, "thickness", line.thickness);
        setOrClearSpec(specs, "finish", line.finish);
        setOrClearSpec(specs, "width", line.width);
        setOrClearSpec(specs, "length", line.length);
        setOrClearSpec(specs, "diameter", line.diameter);

        const requiredDeliveryDate = parseOptionalDate(line.requiredDeliveryDate);
        const promisedDeliveryDate = parseOptionalDate(line.promisedDeliveryDate);
        const uom = line.uom?.trim() || current.uom || "PCS";
        const description =
          line.itemDescription === undefined
            ? current.itemDescription
            : line.itemDescription?.trim() || null;
        const packingTrimmed =
          line.packing === undefined ? current.packing : line.packing?.trim() || null;
        const thicknessTrimmed =
          line.thickness === undefined ? undefined : line.thickness?.trim() || "";
        const gaugeThicknessMm =
          thicknessTrimmed === undefined
            ? undefined
            : thicknessTrimmed && Number.isFinite(Number(thicknessTrimmed))
              ? new Decimal(thicknessTrimmed)
              : null;

        await tx.leadItem.update({
          where: { id: line.id },
          data: {
            itemDescription: description,
            quantity: line.quantity,
            uom,
            ...(line.grade !== undefined
              ? { mfgGrade: line.grade?.trim() || null }
              : {}),
            ...(line.finish !== undefined
              ? { finish: line.finish?.trim() || null }
              : {}),
            packing: packingTrimmed,
            ...(gaugeThicknessMm !== undefined ? { gaugeThicknessMm } : {}),
            notes: line.notes === undefined ? current.notes : line.notes?.trim() || null,
            specifications: specs as object,
            ...(requiredDeliveryDate !== undefined
              ? {
                  requiredDeliveryDate,
                  expectedDeliveryDate: requiredDeliveryDate,
                }
              : {}),
            ...(promisedDeliveryDate !== undefined ? { promisedDeliveryDate } : {}),
          },
        });
      }

      const refreshed = await tx.leadItem.findMany({
        where: { leadId },
        select: { requiredDeliveryDate: true, promisedDeliveryDate: true },
      });
      const earliestRequired = refreshed
        .map((row) => row.requiredDeliveryDate)
        .filter((value): value is Date => Boolean(value))
        .sort((a, b) => a.getTime() - b.getTime())[0];
      const earliestPromised = refreshed
        .map((row) => row.promisedDeliveryDate)
        .filter((value): value is Date => Boolean(value))
        .sort((a, b) => a.getTime() - b.getTime())[0];

      await tx.lead.update({
        where: { id: leadId },
        data: {
          requiredDeliveryDate: earliestRequired ?? null,
          promisedDeliveryDate: earliestPromised ?? null,
          lastActivityAt: new Date(),
        },
      });

      await addLeadActivity(tx, {
        leadId,
        userId: session.userId,
        activityType: "update",
        description: `Updated ${input.items.length} requested item line(s).`,
      });

      return { id: leadId, itemCount: input.items.length };
    },
  });
}

export async function updateLeadDeliveryDates(
  session: SessionUser,
  leadId: string,
  input: {
    requiredDeliveryDate?: string | null;
    promisedDeliveryDate?: string | null;
    items?: {
      id: string;
      requiredDeliveryDate?: string | null;
      promisedDeliveryDate?: string | null;
    }[];
  },
  key: string | null,
) {
  allow(session, "lead.manage");
  return runCommand({
    userId: session.userId,
    route: "lead.dates",
    key,
    run: async (tx) => {
      const lead = await leadForSession(tx, leadId, session);
      const changes: string[] = [];

      const existingItems = await tx.leadItem.findMany({
        where: { leadId },
        select: { id: true, requiredDeliveryDate: true, promisedDeliveryDate: true },
      });
      if (input.items?.length) {
        const allowed = new Set(existingItems.map((row) => row.id));
        const byId = new Map(existingItems.map((row) => [row.id, row]));
        await Promise.all(
          input.items.map(async (line) => {
            if (!allowed.has(line.id)) {
              throw new AppError(400, "VALIDATION", "One or more lead items do not belong to this lead.");
            }
            const requiredDeliveryDate =
              line.requiredDeliveryDate === undefined
                ? undefined
                : line.requiredDeliveryDate
                  ? new Date(line.requiredDeliveryDate)
                  : null;
            const promisedDeliveryDate =
              line.promisedDeliveryDate === undefined
                ? undefined
                : line.promisedDeliveryDate
                  ? new Date(line.promisedDeliveryDate)
                  : null;
            await tx.leadItem.update({
              where: { id: line.id },
              data: {
                ...(requiredDeliveryDate !== undefined
                  ? {
                      requiredDeliveryDate,
                      expectedDeliveryDate: requiredDeliveryDate,
                    }
                  : {}),
                ...(promisedDeliveryDate !== undefined ? { promisedDeliveryDate } : {}),
              },
            });
            const cached = byId.get(line.id);
            if (cached) {
              if (requiredDeliveryDate !== undefined) cached.requiredDeliveryDate = requiredDeliveryDate;
              if (promisedDeliveryDate !== undefined) cached.promisedDeliveryDate = promisedDeliveryDate;
            }
          }),
        );
        changes.push(`Updated delivery dates for ${input.items.length} product line(s)`);
      }

      const earliestRequired = existingItems
        .map((row) => row.requiredDeliveryDate)
        .filter((value): value is Date => Boolean(value))
        .sort((a, b) => a.getTime() - b.getTime())[0];
      const earliestPromised = existingItems
        .map((row) => row.promisedDeliveryDate)
        .filter((value): value is Date => Boolean(value))
        .sort((a, b) => a.getTime() - b.getTime())[0];

      const data: { requiredDeliveryDate?: Date | null; promisedDeliveryDate?: Date | null } = {};
      if (input.items?.length) {
        data.requiredDeliveryDate = earliestRequired ?? null;
        data.promisedDeliveryDate = earliestPromised ?? null;
      } else {
        if (input.requiredDeliveryDate !== undefined) {
          data.requiredDeliveryDate = input.requiredDeliveryDate
            ? new Date(input.requiredDeliveryDate)
            : null;
          changes.push(`Required delivery date: ${input.requiredDeliveryDate || "cleared"}`);
        }
        if (input.promisedDeliveryDate !== undefined) {
          data.promisedDeliveryDate = input.promisedDeliveryDate
            ? new Date(input.promisedDeliveryDate)
            : null;
          changes.push(`Promised delivery date: ${input.promisedDeliveryDate || "cleared"}`);
        }
      }

      if (Object.keys(data).length) {
        await tx.lead.update({
          where: { id: leadId },
          data,
        });
      }

      if (changes.length > 0) {
        await addLeadActivity(tx, {
          leadId,
          userId: session.userId,
          activityType: "update",
          description: `Updated delivery dates: ${changes.join(", ")}.`,
        });
      }

      return {
        id: leadId,
        requiredDeliveryDate:
          data.requiredDeliveryDate !== undefined ? data.requiredDeliveryDate : lead.requiredDeliveryDate,
        promisedDeliveryDate:
          data.promisedDeliveryDate !== undefined ? data.promisedDeliveryDate : lead.promisedDeliveryDate,
      };
    },
  });
}
