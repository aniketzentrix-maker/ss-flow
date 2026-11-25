import { Prisma } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import { plantIdsForSession } from "@/lib/access";
import { AppError } from "@/lib/errors";
import { uuidv7 } from "@/lib/ids";
import { audit, runCommand } from "@/lib/inventory/post";
import {
  activePricingMatchKeys,
  buildNormalizedPricingFingerprint,
  flattenVariantSpecs,
  isProductComingSoon,
  missingPricingSpecFields,
  pricingSpecsComplete,
  RATE_CONFLICT_CODE,
  RATE_CONFLICT_MESSAGE,
  RATE_PENDING_MESSAGE,
  decideCatalogRateReuse,
  resolveProductFieldConfig,
  STALE_SPECIFICATION_CODE,
  STALE_SPECIFICATION_MESSAGE,
} from "@/lib/domain/product-spec-fields";
import { allow } from "@/modules/shared/allow";
import {
  createOrReuseFinish,
  createOrReuseGrade,
  normalizeMasterName,
} from "@/modules/masters/grades-finishes";

export {
  RATE_CONFLICT_CODE,
  RATE_CONFLICT_MESSAGE,
  STALE_SPECIFICATION_CODE,
  STALE_SPECIFICATION_MESSAGE,
};

export type ApplyCatalogRateInput = {
  productId: string;
  specifications: Record<string, string>;
  unitRate: string;
  uom?: string;
  /** Fingerprint frozen when Set Price opened — used for stale-spec detection. */
  expectedPricingFingerprint: string;
  leadId?: string;
  leadItemId?: string;
  /** When master rate differs, apply the existing master rate instead of creating/updating. */
  applyExistingRate?: boolean;
  quantity?: string;
};

export type AppliedCatalogRateResult = {
  productId: string;
  productVariantId: string;
  materialMasterId: string;
  sellingPrice: string;
  pricingFingerprint: string;
  displayName: string;
  uom: string;
  grade?: { id: string; name: string; reused: boolean; created: boolean };
  finish?: { id: string; name: string; reused: boolean; created: boolean };
  leadItemId?: string;
  appliedExistingRate: boolean;
  specs: Record<string, unknown>;
};

function clean(value?: string | null) {
  return value?.trim() || null;
}

function asDecimal(value?: string | null) {
  return value && Number.isFinite(Number(value)) ? new Prisma.Decimal(value) : null;
}

function isUniqueViolation(error: unknown) {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "P2002";
}

function formSpecsFromRecord(specs: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(specs)
      .filter(([, value]) => value != null && String(value).trim())
      .map(([key, value]) => [key, String(value).trim()]),
  );
}

function fingerprintFromLeadItemSpecs(
  specs: Record<string, unknown>,
  config: ReturnType<typeof resolveProductFieldConfig>,
) {
  const formSpecs = Object.fromEntries(
    Object.entries(specs)
      .filter(([, value]) => value != null && typeof value !== "object")
      .map(([key, value]) => [key, String(value).trim()])
      .filter(([, value]) => value),
  );
  if (!config) {
    const keys = Object.keys(formSpecs).sort();
    return buildNormalizedPricingFingerprint(formSpecs, keys, null);
  }
  const keys = activePricingMatchKeys(config, formSpecs);
  return buildNormalizedPricingFingerprint(formSpecs, keys, config);
}

function ratesEqual(a: string | null | undefined, b: string) {
  return decideCatalogRateReuse({
    existingRate: a == null ? null : String(a),
    submittedRate: b,
  }) === "reuse";
}

/**
 * Single-transaction Save & Apply Rate:
 * resolve/create Grade + Finish → create/reuse Product Master rate → apply to lead item (optional).
 */
export async function applyCatalogRate(
  session: SessionUser,
  input: ApplyCatalogRateInput,
  key: string | null,
): Promise<AppliedCatalogRateResult> {
  allow(session, "lead.manage");
  allow(session, "plant.manage");
  if (!key) throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "Send an Idempotency-Key header.");

  const unitRate = input.unitRate?.trim() ?? "";
  if (!unitRate || !Number.isFinite(Number(unitRate)) || Number(unitRate) <= 0) {
    throw new AppError(400, "VALIDATION", "Enter a valid unit rate greater than zero.");
  }
  const formSpecs = formSpecsFromRecord(input.specifications ?? {});
  if (!Object.keys(formSpecs).length) {
    throw new AppError(400, "VALIDATION", "Complete the pricing specification before setting a rate.");
  }

  const plantIds = await plantIdsForSession(session);

  const result = await runCommand({
    userId: session.userId,
    route: "lead.apply_catalog_rate",
    key,
    txOpts: { maxWait: 10_000, timeout: 45_000 },
    run: async (tx) => {
      let product = await tx.product.findFirst({
        where: { id: input.productId, isActive: true },
        include: {
          category: { select: { code: true } },
          variants: {
            include: {
              unit: { select: { id: true, symbol: true, isActive: true } },
              materialMaster: true,
            },
          },
        },
      });
      if (!product) throw new AppError(404, "NOT_FOUND", "Active parent product not found.");
      if (plantIds.length && !plantIds.includes(product.plantId)) {
        const twin = await tx.product.findFirst({
          where: {
            plantId: { in: plantIds },
            sku: { equals: product.sku, mode: "insensitive" },
            isActive: true,
          },
          include: {
            category: { select: { code: true } },
            variants: {
              include: {
                unit: { select: { id: true, symbol: true, isActive: true } },
                materialMaster: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        });
        if (!twin) throw new AppError(403, "FORBIDDEN", "Product is outside your plant access.");
        product = twin;
      }
      if (isProductComingSoon(product)) {
        throw new AppError(400, "VALIDATION", "Semi Finish Utensils is coming soon and cannot be requested yet.");
      }

      const config = resolveProductFieldConfig(product);
      if (config && !pricingSpecsComplete(config, formSpecs)) {
        const missing = missingPricingSpecFields(config, formSpecs);
        throw new AppError(
          400,
          "VALIDATION",
          missing.length
            ? `Complete required pricing fields: ${missing.join(", ")}.`
            : "Complete the pricing specification before setting a rate.",
        );
      }

      const pricingKeys = config
        ? activePricingMatchKeys(config, formSpecs)
        : Object.keys(formSpecs).filter((keyName) => formSpecs[keyName]);
      const pricingFingerprint = buildNormalizedPricingFingerprint(formSpecs, pricingKeys, config);
      if (
        !input.expectedPricingFingerprint?.trim() ||
        input.expectedPricingFingerprint.trim() !== pricingFingerprint
      ) {
        throw new AppError(409, STALE_SPECIFICATION_CODE, STALE_SPECIFICATION_MESSAGE, {
          expectedPricingFingerprint: input.expectedPricingFingerprint,
          currentPricingFingerprint: pricingFingerprint,
        });
      }

      let leadItem: {
        id: string;
        leadId: string;
        quantity: Prisma.Decimal;
        uom: string;
        specifications: unknown;
        parentProductId: string | null;
      } | null = null;

      if (input.leadItemId) {
        if (!input.leadId) {
          throw new AppError(400, "VALIDATION", "leadId is required when applying a rate to a lead item.");
        }
        leadItem = await tx.leadItem.findFirst({
          where: {
            id: input.leadItemId,
            leadId: input.leadId,
            lead: {
              deletedAt: null,
              ...(plantIds.length ? { plantId: { in: plantIds } } : {}),
            },
          },
          select: {
            id: true,
            leadId: true,
            quantity: true,
            uom: true,
            specifications: true,
            parentProductId: true,
          },
        });
        if (!leadItem) throw new AppError(404, "NOT_FOUND", "Lead item not found.");
        if (leadItem.parentProductId && leadItem.parentProductId !== product.id) {
          // Allow twin remap — parent on item may be catalog twin id.
          const itemParent = await tx.product.findUnique({
            where: { id: leadItem.parentProductId },
            select: { sku: true },
          });
          if (!itemParent || itemParent.sku.toLowerCase() !== product.sku.toLowerCase()) {
            throw new AppError(400, "VALIDATION", "Lead item product does not match the rate product.");
          }
        }
        const savedSpecs =
          leadItem.specifications &&
          typeof leadItem.specifications === "object" &&
          !Array.isArray(leadItem.specifications)
            ? (leadItem.specifications as Record<string, unknown>)
            : {};
        const itemFingerprint = fingerprintFromLeadItemSpecs(savedSpecs, config);
        if (itemFingerprint !== pricingFingerprint) {
          throw new AppError(409, STALE_SPECIFICATION_CODE, STALE_SPECIFICATION_MESSAGE, {
            expectedPricingFingerprint: pricingFingerprint,
            leadItemPricingFingerprint: itemFingerprint,
          });
        }
      }

      const gradeName = clean(formSpecs.grade);
      const finishName = clean(formSpecs.finish);
      let gradeMeta: AppliedCatalogRateResult["grade"];
      let finishMeta: AppliedCatalogRateResult["finish"];

      if (gradeName) {
        const before = await tx.gradeMaster.findUnique({
          where: {
            plantId_normalizedName: {
              plantId: product.plantId,
              normalizedName: normalizeMasterName(gradeName),
            },
          },
          select: { id: true },
        });
        const gradeResult = await createOrReuseGrade(
          session,
          { name: gradeName, productId: product.id, plantId: product.plantId },
          tx,
        );
        gradeMeta = {
          id: gradeResult.grade.id,
          name: gradeResult.grade.name,
          reused: gradeResult.reused,
          created: !before,
        };
      }

      if (finishName) {
        const before = await tx.finishMaster.findUnique({
          where: {
            plantId_normalizedName: {
              plantId: product.plantId,
              normalizedName: normalizeMasterName(finishName),
            },
          },
          select: { id: true },
        });
        const finishResult = await createOrReuseFinish(
          session,
          { name: finishName, productId: product.id, plantId: product.plantId },
          tx,
        );
        finishMeta = {
          id: finishResult.finish.id,
          name: finishResult.finish.name,
          reused: finishResult.reused,
          created: !before,
        };
      }

      const resolvedGradeName = gradeMeta?.name ?? gradeName;
      const resolvedFinishName = finishMeta?.name ?? finishName;

      const unit = input.uom?.trim()
        ? await tx.unitOfMeasure.findFirst({
            where: { plantId: product.plantId, symbol: input.uom.trim(), isActive: true },
            select: { id: true, symbol: true },
          })
        : product.variants.find((variant) => variant.unit?.isActive)?.unit;
      if (!unit) throw new AppError(400, "VALIDATION", "Choose a valid unit of measure.");

      const baseMaterial = product.variants.find((variant) => variant.materialMaster)?.materialMaster;
      if (!baseMaterial) {
        throw new AppError(
          409,
          "INVALID_STATE",
          "This product has no linked stock SKU to use as a variant template.",
        );
      }

      const thicknessMm = clean(formSpecs.thickness);
      const widthMm = clean(formSpecs.width);
      const lengthMm = clean(formSpecs.length);
      const diameterMm = clean(formSpecs.diameter);

      const attrs: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(formSpecs)) {
        if (["grade", "finish", "thickness", "width", "length", "diameter"].includes(key)) continue;
        attrs[key] = value;
      }
      if (resolvedGradeName) attrs.grade = resolvedGradeName;
      if (resolvedFinishName) attrs.finish = resolvedFinishName;
      if (thicknessMm) attrs.thickness = thicknessMm;
      if (widthMm) attrs.width = widthMm;
      if (lengthMm) attrs.length = lengthMm;
      if (diameterMm) attrs.diameter = diameterMm;
      attrs.catalogSellingPrice = new Prisma.Decimal(unitRate).toFixed(2);

      const candidateSpecs = flattenVariantSpecs({
        grade: resolvedGradeName,
        finish: resolvedFinishName,
        thicknessMm,
        widthMm,
        lengthMm,
        diameterMm,
        attributes: attrs,
      });

      type ExistingVariant = (typeof product.variants)[number] & {
        pricingFingerprint?: string | null;
        gradeId?: string | null;
        finishId?: string | null;
      };

      let existing: ExistingVariant | undefined = product.variants.find(
        (variant) =>
          variant.isActive &&
          (variant as ExistingVariant).pricingFingerprint === pricingFingerprint,
      );

      if (!existing) {
        // Fingerprint may be null on legacy rows — fall back to normalized compare.
        existing = product.variants.find((variant) => {
          if (!variant.isActive) return false;
          const otherAttrs =
            variant.attributes &&
            typeof variant.attributes === "object" &&
            !Array.isArray(variant.attributes)
              ? (variant.attributes as Record<string, unknown>)
              : {};
          const otherSpecs = flattenVariantSpecs({
            grade: variant.grade,
            finish: variant.finish,
            thicknessMm: variant.thicknessMm?.toString() ?? null,
            widthMm: variant.widthMm?.toString() ?? null,
            lengthMm: variant.lengthMm?.toString() ?? null,
            diameterMm: variant.diameterMm?.toString() ?? null,
            attributes: otherAttrs,
          });
          return (
            buildNormalizedPricingFingerprint(otherSpecs, pricingKeys, config) === pricingFingerprint
          );
        });
      }

      // Refresh from DB in case concurrent create committed (variants include may be stale).
      if (!existing) {
        const byFingerprint = await tx.productVariant.findFirst({
          where: {
            productId: product.id,
            isActive: true,
            // pricingFingerprint column (migration 20261125110000); cast until client regenerates.
            ...({ pricingFingerprint } as object),
          } as Prisma.ProductVariantWhereInput,
          include: {
            unit: { select: { id: true, symbol: true, isActive: true } },
            materialMaster: true,
          },
        });
        if (byFingerprint) existing = byFingerprint as ExistingVariant;
      }

      let appliedExistingRate = false;
      let variantId: string;
      let materialMasterId: string;
      let sellingPriceText: string;
      let displayName: string;

      if (existing) {
        const masterRate = existing.materialMaster?.sellingPrice?.toString() ?? null;
        const decision = decideCatalogRateReuse({
          existingRate: masterRate,
          submittedRate: unitRate,
          applyExistingRate: input.applyExistingRate,
        });
        if (decision === "conflict") {
          throw new AppError(409, RATE_CONFLICT_CODE, RATE_CONFLICT_MESSAGE, {
            existingRate: masterRate,
            submittedRate: unitRate,
            productVariantId: existing.id,
            materialMasterId: existing.materialMasterId,
            pricingFingerprint,
            displayName: existing.displayName,
            uom: existing.unit?.symbol ?? unit.symbol,
          });
        }
        appliedExistingRate = decision === "reuse" && Boolean(masterRate) && !ratesEqual(masterRate, unitRate);
        variantId = existing.id;
        materialMasterId = existing.materialMasterId ?? existing.id;
        sellingPriceText =
          decision === "fill_blank"
            ? unitRate
            : appliedExistingRate
              ? (masterRate as string)
              : (masterRate as string);
        displayName =
          existing.displayName ??
          [product.name, resolvedGradeName, resolvedFinishName, thicknessMm && `${thicknessMm} mm`]
            .filter(Boolean)
            .join(" · ");

        await tx.productVariant.update({
          where: { id: variantId },
          data: {
            grade: resolvedGradeName,
            finish: resolvedFinishName,
            gradeId: gradeMeta?.id ?? existing.gradeId ?? null,
            finishId: finishMeta?.id ?? existing.finishId ?? null,
            ...({ pricingFingerprint } as object),
          } as Prisma.ProductVariantUpdateInput,
        });
        if (decision === "fill_blank" && existing.materialMasterId) {
          await tx.materialMaster.update({
            where: { id: existing.materialMasterId },
            data: { sellingPrice: new Prisma.Decimal(unitRate) },
          });
        }
      } else {
        displayName = [
          product.name,
          resolvedGradeName,
          resolvedFinishName,
          thicknessMm && `${thicknessMm} mm`,
          widthMm && `W ${widthMm} mm`,
        ]
          .filter(Boolean)
          .join(" · ");
        variantId = uuidv7();
        materialMasterId = uuidv7();
        const sku = `${product.sku.slice(0, 20)}-V${variantId.slice(-6).toUpperCase()}`;
        const parsedSellingPrice = new Prisma.Decimal(unitRate);
        sellingPriceText = parsedSellingPrice.toString();

        try {
          await tx.materialMaster.create({
            data: {
              id: materialMasterId,
              plantId: product.plantId,
              code: sku,
              name: displayName,
              category: baseMaterial.category,
              categoryId: baseMaterial.categoryId,
              productType: baseMaterial.productType,
              shape: baseMaterial.shape,
              description: baseMaterial.description,
              brand: baseMaterial.brand,
              hsnCode: baseMaterial.hsnCode,
              uom: unit.symbol,
              purchaseUom: baseMaterial.purchaseUom,
              salesUom: unit.symbol,
              batchTracking: baseMaterial.batchTracking,
              serialTracking: baseMaterial.serialTracking,
              grade: resolvedGradeName,
              thickness: asDecimal(thicknessMm),
              width: asDecimal(widthMm),
              length: asDecimal(lengthMm),
              diameter: asDecimal(diameterMm),
              purchaseAllowed: baseMaterial.purchaseAllowed,
              salesAllowed: baseMaterial.salesAllowed,
              manufacturingAllowed: baseMaterial.manufacturingAllowed,
              purchasePrice: baseMaterial.purchasePrice,
              sellingPrice: parsedSellingPrice,
              taxRate: baseMaterial.taxRate,
              specs: attrs as Prisma.InputJsonObject,
              active: true,
            },
          });
          await tx.productVariant.create({
            data: {
              id: variantId,
              plantId: product.plantId,
              productId: product.id,
              sku,
              displayName,
              materialMasterId,
              unitId: unit.id,
              grade: resolvedGradeName,
              finish: resolvedFinishName,
              thicknessMm: asDecimal(thicknessMm),
              widthMm: asDecimal(widthMm),
              lengthMm: asDecimal(lengthMm),
              diameterMm: asDecimal(diameterMm),
              gradeId: gradeMeta?.id ?? null,
              finishId: finishMeta?.id ?? null,
              attributes: attrs as Prisma.InputJsonObject,
              isActive: true,
              ...({ pricingFingerprint } as object),
            } as Prisma.ProductVariantUncheckedCreateInput,
          });
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          const winner = await tx.productVariant.findFirst({
            where: {
              productId: product.id,
              isActive: true,
              ...({ pricingFingerprint } as object),
            } as Prisma.ProductVariantWhereInput,
            include: { materialMaster: true, unit: { select: { symbol: true } } },
          });
          if (!winner) throw error;
          const masterRate = winner.materialMaster?.sellingPrice?.toString() ?? null;
          if (!ratesEqual(masterRate, unitRate) && !input.applyExistingRate) {
            throw new AppError(409, RATE_CONFLICT_CODE, RATE_CONFLICT_MESSAGE, {
              existingRate: masterRate,
              submittedRate: unitRate,
              productVariantId: winner.id,
              materialMasterId: winner.materialMasterId,
              pricingFingerprint,
              displayName: winner.displayName,
              uom: winner.unit?.symbol ?? unit.symbol,
            });
          }
          appliedExistingRate = Boolean(masterRate && !ratesEqual(masterRate, unitRate));
          variantId = winner.id;
          materialMasterId = winner.materialMasterId ?? winner.id;
          sellingPriceText = (masterRate as string) || unitRate;
          displayName = winner.displayName ?? displayName;
        }

        await audit(tx, {
          userId: session.userId,
          action: "product.variant.create",
          resource: "product_variant",
          resourceId: variantId,
          payload: { via: "lead.apply_catalog_rate", pricingFingerprint },
        });
      }

      const resolvedSpecs: Record<string, string> = Object.fromEntries(
        Object.entries({
          ...candidateSpecs,
          grade: resolvedGradeName ?? candidateSpecs.grade,
          finish: resolvedFinishName ?? candidateSpecs.finish,
        })
          .filter(([, value]) => value != null && typeof value !== "object" && String(value).trim())
          .map(([key, value]) => [key, String(value).trim()]),
      );

      if (leadItem) {
        await tx.leadItem.update({
          where: { id: leadItem.id },
          data: {
            parentProductId: product.id,
            productVariantId: variantId,
            productId: materialMasterId,
            marketPrice: new Prisma.Decimal(sellingPriceText),
            targetPrice: sellingPriceText,
            priceOffered: new Prisma.Decimal(sellingPriceText),
            specifications: {
              ...(typeof leadItem.specifications === "object" &&
              leadItem.specifications &&
              !Array.isArray(leadItem.specifications)
                ? (leadItem.specifications as Record<string, unknown>)
                : {}),
              ...resolvedSpecs,
              variantDisplayName: displayName,
            } as Prisma.InputJsonObject,
          },
        });
      }

      const payload: AppliedCatalogRateResult = {
        productId: product.id,
        productVariantId: variantId,
        materialMasterId,
        sellingPrice: sellingPriceText,
        pricingFingerprint,
        displayName,
        uom: unit.symbol,
        grade: gradeMeta,
        finish: finishMeta,
        leadItemId: leadItem?.id,
        appliedExistingRate,
        specs: resolvedSpecs,
      };
      return payload as unknown as Prisma.InputJsonObject;
    },
  });
  return result as unknown as AppliedCatalogRateResult;
}

