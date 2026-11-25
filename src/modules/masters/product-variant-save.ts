import { Prisma } from "@prisma/client";
import { prisma } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { plantIdsForSession } from "@/lib/access";
import { AppError } from "@/lib/errors";
import { uuidv7 } from "@/lib/ids";
import { audit, runCommand } from "@/lib/inventory/post";
import { allow } from "@/modules/shared/allow";
import { pgSchemaFromEnv } from "@/lib/db/pg-schema";
import { normalizeMasterName } from "./grades-finishes";
import {
  activePricingMatchKeys,
  buildNormalizedPricingFingerprint,
  flattenVariantSpecs,
  resolveProductFieldConfig,
} from "@/lib/domain/product-spec-fields";

export type ProductVariantInput = {
  id?: string;
  displayName?: string;
  grade?: string;
  finish?: string;
  thickness?: string;
  width?: string;
  length?: string;
  diameter?: string;
  uom?: string;
  /** Per-spec list price (stored on linked MaterialMaster.sellingPrice). */
  sellingPrice?: string;
  attributes?: Record<string, unknown>;
  isActive?: boolean;
};

type SaveResult = {
  id: string;
  displayName: string;
  isActive: boolean;
  sellingPrice: string | null;
  sku?: string;
};

/**
 * Desk variant save — optimized for Neon latency from India (~2s/RTT).
 * Edit path aims for ~1 batched write round-trip after a cheap idempotency check.
 */
export async function saveProductVariant(
  session: SessionUser,
  productId: string,
  input: ProductVariantInput,
  key: string | null,
) {
  allow(session, "plant.manage");
  if (!key) throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "Send an Idempotency-Key header.");
  const plantIds = await plantIdsForSession(session);

  if (input.id) {
    return saveExistingVariantFast(session, productId, input, key, plantIds);
  }
  return saveNewVariant(session, productId, input, key, plantIds);
}

function clean(value?: string | null) {
  return value?.trim() || null;
}
function numeric(value?: string) {
  return value?.trim() ? value.trim() : null;
}
function asDecimal(value?: string | null) {
  return value && Number.isFinite(Number(value)) ? new Prisma.Decimal(value) : null;
}

async function saveExistingVariantFast(
  session: SessionUser,
  productId: string,
  input: ProductVariantInput,
  key: string,
  plantIds: string[],
): Promise<SaveResult> {
  const route = "product.variant.update";

  const variantSelect = {
    id: true,
    sku: true,
    productId: true,
    plantId: true,
    displayName: true,
    grade: true,
    finish: true,
    gradeId: true,
    finishId: true,
    thicknessMm: true,
    widthMm: true,
    lengthMm: true,
    diameterMm: true,
    attributes: true,
    isActive: true,
    materialMasterId: true,
    unitId: true,
    unit: { select: { id: true, symbol: true, isActive: true } },
    materialMaster: { select: { id: true, sellingPrice: true } },
    product: { select: { id: true, sku: true, name: true, plantId: true, isActive: true } },
  } as const;

  // Parallel: idempotency + variant by id (1 RTT wave).
  const [prior, byId] = await Promise.all([
    prisma.idempotencyKey.findUnique({
      where: { userId_route_key: { userId: session.userId, route, key } },
      select: { response: true },
    }),
    prisma.productVariant.findFirst({
      where: { id: input.id, product: { isActive: true } },
      select: variantSelect,
    }),
  ]);
  if (prior) return prior.response as SaveResult;

  let existing = byId;

  // Cross-plant URL → writable twin by product SKU + variant SKU.
  if (existing && plantIds.length && !plantIds.includes(existing.product.plantId)) {
    existing = await prisma.productVariant.findFirst({
      where: {
        sku: existing.sku,
        product: {
          plantId: { in: plantIds },
          sku: { equals: existing.product.sku, mode: "insensitive" },
          isActive: true,
        },
      },
      select: variantSelect,
      orderBy: { createdAt: "asc" },
    });
  } else if (existing && existing.productId !== productId && plantIds.includes(existing.product.plantId)) {
    // ok — resolved row is already in an accessible plant
  } else if (existing && existing.productId !== productId && !plantIds.length) {
    // universal catalog edit in place
  } else if (!existing) {
    throw new AppError(404, "NOT_FOUND", "Variant not found under this product.");
  }

  if (!existing) throw new AppError(404, "NOT_FOUND", "Variant not found under this product.");
  if (!existing.materialMasterId) {
    // Rare legacy path — fall through to fuller create-material flow via interactive tx helper.
    return saveExistingWithMaterialCreate(session, existing, input, key, plantIds);
  }

  const values = {
    grade: clean(input.grade),
    finish: clean(input.finish),
    thicknessMm: numeric(input.thickness),
    widthMm: numeric(input.width),
    lengthMm: numeric(input.length),
    diameterMm: numeric(input.diameter),
  };

  const specsUnchanged =
    (values.grade ?? null) === (existing.grade ?? null) &&
    (values.finish ?? null) === (existing.finish ?? null) &&
    (values.thicknessMm ?? null) === (existing.thicknessMm?.toString() ?? null) &&
    (values.widthMm ?? null) === (existing.widthMm?.toString() ?? null) &&
    (values.lengthMm ?? null) === (existing.lengthMm?.toString() ?? null) &&
    (values.diameterMm ?? null) === (existing.diameterMm?.toString() ?? null);

  const uomSymbol = input.uom?.trim();
  const unitOk =
    Boolean(uomSymbol) &&
    existing.unit?.isActive !== false &&
    existing.unit?.symbol === uomSymbol;

  const previousAttrs =
    existing.attributes &&
    typeof existing.attributes === "object" &&
    !Array.isArray(existing.attributes)
      ? (existing.attributes as Record<string, unknown>)
      : {};
  const attrs: Record<string, unknown> = { ...(input.attributes ?? previousAttrs) };
  for (const [keyName, value] of Object.entries({
    grade: values.grade,
    finish: values.finish,
    thickness: values.thicknessMm,
    width: values.widthMm,
    length: values.lengthMm,
    diameter: values.diameterMm,
  })) {
    delete attrs[keyName];
    if (value) attrs[keyName] = value;
  }

  const priceProvided = input.sellingPrice !== undefined;
  const parsedSellingPrice = priceProvided
    ? input.sellingPrice!.trim()
      ? new Prisma.Decimal(input.sellingPrice!.trim())
      : null
    : undefined;
  if (priceProvided) {
    attrs.catalogSellingPrice =
      parsedSellingPrice != null ? parsedSellingPrice.toFixed(2) : null;
  }

  // Price-only / unchanged-spec edits: skip duplicate + grade/finish lookups.
  let unitId = existing.unitId;
  let unitSymbol = existing.unit?.symbol ?? "KG";
  let gradeId = existing.gradeId;
  let finishId = existing.finishId;
  let resolvedGrade = existing.grade;
  let resolvedFinish = existing.finish;
  let candidateFingerprintForWrite: string | null = null;

  {
    const config = resolveProductFieldConfig(existing.product);
    const candidateSpecs = flattenVariantSpecs({
      grade: values.grade,
      finish: values.finish,
      thicknessMm: values.thicknessMm,
      widthMm: values.widthMm,
      lengthMm: values.lengthMm,
      diameterMm: values.diameterMm,
      attributes: attrs,
    });
    const formSpecs = Object.fromEntries(
      Object.entries(candidateSpecs)
        .filter(([, value]) => value != null && typeof value !== "object")
        .map(([keyName, value]) => [keyName, String(value)]),
    );
    const pricingKeys = config
      ? activePricingMatchKeys(config, formSpecs)
      : Object.keys(formSpecs).filter((keyName) => String(formSpecs[keyName] ?? "").trim());
    candidateFingerprintForWrite = buildNormalizedPricingFingerprint(
      candidateSpecs,
      pricingKeys,
      config,
    );
  }

  if (!specsUnchanged || !unitOk) {
    const product = existing.product;
    const config = resolveProductFieldConfig(product);
    const candidateFingerprint = candidateFingerprintForWrite!;
    const formSpecs = Object.fromEntries(
      Object.entries(
        flattenVariantSpecs({
          grade: values.grade,
          finish: values.finish,
          thicknessMm: values.thicknessMm,
          widthMm: values.widthMm,
          lengthMm: values.lengthMm,
          diameterMm: values.diameterMm,
          attributes: attrs,
        }),
      )
        .filter(([, value]) => value != null && typeof value !== "object")
        .map(([keyName, value]) => [keyName, String(value)]),
    );
    const pricingKeys = config
      ? activePricingMatchKeys(config, formSpecs)
      : Object.keys(formSpecs).filter((keyName) => String(formSpecs[keyName] ?? "").trim());

    const gradeNorm = values.grade?.trim() ? normalizeMasterName(values.grade) : null;
    const finishNorm = values.finish?.trim() ? normalizeMasterName(values.finish) : null;
    const needGrade =
      Boolean(gradeNorm) &&
      !(
        existing.gradeId &&
        existing.grade &&
        gradeNorm === normalizeMasterName(existing.grade)
      );
    const needFinish =
      Boolean(finishNorm) &&
      !(
        existing.finishId &&
        existing.finish &&
        finishNorm === normalizeMasterName(existing.finish)
      );

    const [siblings, unitRow, gradeCompat, finishCompat] = await Promise.all([
      prisma.productVariant.findMany({
        where: { productId: product.id, isActive: true, id: { not: existing.id } },
        select: {
          grade: true,
          finish: true,
          thicknessMm: true,
          widthMm: true,
          lengthMm: true,
          diameterMm: true,
          attributes: true,
        },
      }),
      unitOk
        ? Promise.resolve(existing.unit!)
        : uomSymbol
          ? prisma.unitOfMeasure.findFirst({
              where: { plantId: product.plantId, symbol: uomSymbol, isActive: true },
              select: { id: true, symbol: true, isActive: true },
            })
          : Promise.resolve(existing.unit),
      needGrade
        ? prisma.productGradeCompatibility.findFirst({
            where: {
              productId: product.id,
              isActive: true,
              grade: { normalizedName: gradeNorm!, isActive: true },
            },
            select: { grade: { select: { id: true, name: true } } },
          })
        : Promise.resolve(null),
      needFinish
        ? prisma.productFinishCompatibility.findFirst({
            where: {
              productId: product.id,
              isActive: true,
              finish: { normalizedName: finishNorm!, isActive: true },
            },
            select: { finish: { select: { id: true, name: true } } },
          })
        : Promise.resolve(null),
    ]);

    if (!unitRow) throw new AppError(400, "VALIDATION", "Choose a valid unit of measure.");
    if (needGrade && !gradeCompat) {
      throw new AppError(
        400,
        "VALIDATION",
        `Grade "${values.grade}" is not configured as a compatible active grade for "${product.name}".`,
      );
    }
    if (needFinish && !finishCompat) {
      throw new AppError(
        400,
        "VALIDATION",
        `Finish "${values.finish}" is not configured as a compatible active finish for "${product.name}".`,
      );
    }

    const duplicates = siblings.filter((variant) => {
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
        buildNormalizedPricingFingerprint(otherSpecs, pricingKeys, config) ===
        candidateFingerprint
      );
    });
    if (duplicates.length && input.isActive !== false) {
      throw new AppError(
        409,
        "DUPLICATE",
        "An active variant with these pricing specifications already exists.",
      );
    }

    unitId = unitRow.id;
    unitSymbol = unitRow.symbol;
    gradeId = needGrade ? gradeCompat!.grade.id : existing.gradeId;
    finishId = needFinish ? finishCompat!.finish.id : existing.finishId;
    resolvedGrade = needGrade ? gradeCompat!.grade.name : (existing.grade ?? values.grade);
    resolvedFinish = needFinish
      ? finishCompat!.finish.name
      : (existing.finish ?? values.finish);
  } else {
    resolvedGrade = values.grade ?? existing.grade;
    resolvedFinish = values.finish ?? existing.finish;
  }

  const displayName =
    clean(input.displayName) ??
    [
      existing.product.name,
      values.grade,
      values.finish,
      values.thicknessMm && `${values.thicknessMm} mm`,
      values.widthMm && `W ${values.widthMm} mm`,
      values.lengthMm && `L ${values.lengthMm} mm`,
      values.diameterMm && `Ø ${values.diameterMm} mm`,
    ]
      .filter(Boolean)
      .join(" · ");
  const active = input.isActive ?? existing.isActive;

  const response: SaveResult = {
    id: existing.id,
    displayName,
    isActive: active,
    sellingPrice: null,
  };

  const previousPrice =
    existing.materialMaster?.sellingPrice != null
      ? Number(existing.materialMaster.sellingPrice).toFixed(2)
      : null;
  const nextPrice = parsedSellingPrice != null ? parsedSellingPrice.toFixed(2) : null;
  const shouldMirror = priceProvided && previousPrice !== nextPrice;

  try {
    const writeOps: Prisma.PrismaPromise<unknown>[] = [
      prisma.materialMaster.update({
        where: { id: existing.materialMasterId },
        data: {
          name: displayName,
          grade: resolvedGrade,
          thickness: asDecimal(values.thicknessMm),
          width: asDecimal(values.widthMm),
          length: asDecimal(values.lengthMm),
          diameter: asDecimal(values.diameterMm),
          uom: unitSymbol,
          salesUom: unitSymbol,
          active,
          specs: attrs as Prisma.InputJsonObject,
          ...(priceProvided ? { sellingPrice: parsedSellingPrice } : {}),
        },
        select: { sellingPrice: true },
      }),
      prisma.productVariant.update({
        where: { id: existing.id },
        data: {
          displayName,
          ...values,
          grade: resolvedGrade,
          finish: resolvedFinish,
          gradeId,
          finishId,
          unitId: unitId!,
          attributes: attrs as Prisma.InputJsonObject,
          isActive: active,
          ...(candidateFingerprintForWrite
            ? ({ pricingFingerprint: candidateFingerprintForWrite } as object)
            : {}),
        } as Prisma.ProductVariantUpdateInput,
      }),
      prisma.auditEvent.create({
        data: {
          id: uuidv7(),
          userId: session.userId,
          action: active ? "product.variant.update" : "product.variant.deactivate",
          resource: "product_variant",
          resourceId: existing.id,
          payload: {},
        },
      }),
    ];

    if (shouldMirror) {
      const schema = pgSchemaFromEnv().replace(/"/g, "");
      writeOps.push(
        prisma.$executeRawUnsafe(
          `UPDATE "${schema}".material_masters AS m
           SET selling_price = $1::numeric
           FROM "${schema}".product_variants AS v
           WHERE v.sku = $2
             AND v.material_master_id = m.id
             AND v.material_master_id IS DISTINCT FROM $3::uuid`,
          parsedSellingPrice,
          existing.sku,
          existing.materialMasterId,
        ),
      );
    }

    writeOps.push(
      prisma.idempotencyKey.create({
        data: {
          id: uuidv7(),
          userId: session.userId,
          route,
          key,
          response: {
            id: existing.id,
            displayName,
            isActive: active,
            sellingPrice: priceProvided
              ? (parsedSellingPrice?.toString() ?? null)
              : (existing.materialMaster?.sellingPrice?.toString() ?? null),
          },
        },
      }),
    );

    // One batched round-trip for all writes (~1 Neon RTT).
    const results = await prisma.$transaction(writeOps);
    const saved = results[0] as { sellingPrice: Prisma.Decimal | null };
    response.sellingPrice = saved.sellingPrice?.toString() ?? null;
    return response;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === "P2002") {
      const again = await prisma.idempotencyKey.findUnique({
        where: { userId_route_key: { userId: session.userId, route, key } },
        select: { response: true },
      });
      if (again) return again.response as SaveResult;
    }
    throw error;
  }
}

/** Rare path: variant has no materialMasterId yet. */
async function saveExistingWithMaterialCreate(
  session: SessionUser,
  existing: {
    id: string;
    sku: string;
    productId: string;
    plantId: string;
    product: { id: string; sku: string; name: string; plantId: string };
  },
  input: ProductVariantInput,
  key: string,
  _plantIds: string[],
): Promise<SaveResult> {
  return runCommand({
    userId: session.userId,
    route: "product.variant.update",
    key,
    txOpts: { maxWait: 5_000, timeout: 15_000 },
    run: async (tx) => {
      const baseMaterial = await tx.materialMaster.findFirst({
        where: { productVariant: { productId: existing.productId } },
      });
      if (!baseMaterial) {
        throw new AppError(
          409,
          "INVALID_STATE",
          "This product has no linked stock SKU to use as a variant template.",
        );
      }
      const unit = input.uom
        ? await tx.unitOfMeasure.findFirst({
            where: { plantId: existing.plantId, symbol: input.uom, isActive: true },
          })
        : await tx.unitOfMeasure.findFirst({
            where: { plantId: existing.plantId, isActive: true },
          });
      if (!unit) throw new AppError(400, "VALIDATION", "Choose a valid unit of measure.");

      const values = {
        grade: clean(input.grade),
        finish: clean(input.finish),
        thicknessMm: numeric(input.thickness),
        widthMm: numeric(input.width),
        lengthMm: numeric(input.length),
        diameterMm: numeric(input.diameter),
      };
      const displayName =
        clean(input.displayName) ??
        [existing.product.name, values.grade, values.finish].filter(Boolean).join(" · ");
      const parsedSellingPrice =
        input.sellingPrice !== undefined
          ? input.sellingPrice.trim()
            ? new Prisma.Decimal(input.sellingPrice.trim())
            : null
          : null;
      const materialMasterId = uuidv7();
      const sku = `${existing.product.sku.slice(0, 20)}-V${existing.id.slice(-6).toUpperCase()}`;
      const active = input.isActive ?? true;
      const attrs = {
        ...(input.attributes ?? {}),
        ...(parsedSellingPrice != null
          ? { catalogSellingPrice: parsedSellingPrice.toFixed(2) }
          : { catalogSellingPrice: null }),
      };

      await tx.materialMaster.create({
        data: {
          id: materialMasterId,
          plantId: existing.plantId,
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
          grade: values.grade,
          thickness: asDecimal(values.thicknessMm),
          width: asDecimal(values.widthMm),
          length: asDecimal(values.lengthMm),
          diameter: asDecimal(values.diameterMm),
          purchaseAllowed: baseMaterial.purchaseAllowed,
          salesAllowed: baseMaterial.salesAllowed,
          manufacturingAllowed: baseMaterial.manufacturingAllowed,
          purchasePrice: baseMaterial.purchasePrice,
          sellingPrice: parsedSellingPrice,
          taxRate: baseMaterial.taxRate,
          specs: attrs as Prisma.InputJsonObject,
          active,
        },
      });
      await tx.productVariant.update({
        where: { id: existing.id },
        data: {
          displayName,
          ...values,
          unitId: unit.id,
          materialMasterId,
          attributes: attrs as Prisma.InputJsonObject,
          isActive: active,
        },
      });
      await audit(tx, {
        userId: session.userId,
        action: "product.variant.update",
        resource: "product_variant",
        resourceId: existing.id,
      });
      return {
        id: existing.id,
        displayName,
        isActive: active,
        sellingPrice: parsedSellingPrice?.toString() ?? null,
      };
    },
  });
}

async function saveNewVariant(
  session: SessionUser,
  productId: string,
  input: ProductVariantInput,
  key: string,
  plantIds: string[],
): Promise<SaveResult> {
  return runCommand({
    userId: session.userId,
    route: "product.variant.create",
    key,
    txOpts: { maxWait: 5_000, timeout: 15_000 },
    run: async (tx) => {
      let product = await tx.product.findFirst({
        where: { id: productId, isActive: true },
        include: {
          variants: {
            include: {
              unit: { select: { id: true, symbol: true } },
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
            variants: {
              include: {
                unit: { select: { id: true, symbol: true } },
                materialMaster: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        });
        if (twin) product = twin;
      }

      const values = {
        grade: clean(input.grade),
        finish: clean(input.finish),
        thicknessMm: numeric(input.thickness),
        widthMm: numeric(input.width),
        lengthMm: numeric(input.length),
        diameterMm: numeric(input.diameter),
      };
      const baseMaterial = product.variants.find((variant) => variant.materialMaster)?.materialMaster;
      if (!baseMaterial) {
        throw new AppError(
          409,
          "INVALID_STATE",
          "This product has no linked stock SKU to use as a variant template.",
        );
      }
      const attrs: Record<string, unknown> = { ...(input.attributes ?? {}) };
      for (const [keyName, value] of Object.entries({
        grade: values.grade,
        finish: values.finish,
        thickness: values.thicknessMm,
        width: values.widthMm,
        length: values.lengthMm,
        diameter: values.diameterMm,
      })) {
        delete attrs[keyName];
        if (value) attrs[keyName] = value;
      }

      const unit = input.uom
        ? await tx.unitOfMeasure.findFirst({
            where: { plantId: product.plantId, symbol: input.uom, isActive: true },
            select: { id: true, symbol: true },
          })
        : product.variants.find((variant) => variant.unit)?.unit;
      if (!unit) throw new AppError(400, "VALIDATION", "Choose a valid unit of measure.");

      const gradeNorm = values.grade?.trim() ? normalizeMasterName(values.grade) : null;
      const finishNorm = values.finish?.trim() ? normalizeMasterName(values.finish) : null;
      const gradeCompat = gradeNorm
        ? await tx.productGradeCompatibility.findFirst({
            where: {
              productId: product.id,
              isActive: true,
              grade: { normalizedName: gradeNorm, isActive: true },
            },
            select: { grade: { select: { id: true, name: true } } },
          })
        : null;
      if (gradeNorm && !gradeCompat) {
        throw new AppError(
          400,
          "VALIDATION",
          `Grade "${values.grade}" is not configured as a compatible active grade for "${product.name}".`,
        );
      }
      const finishCompat = finishNorm
        ? await tx.productFinishCompatibility.findFirst({
            where: {
              productId: product.id,
              isActive: true,
              finish: { normalizedName: finishNorm, isActive: true },
            },
            select: { finish: { select: { id: true, name: true } } },
          })
        : null;
      if (finishNorm && !finishCompat) {
        throw new AppError(
          400,
          "VALIDATION",
          `Finish "${values.finish}" is not configured as a compatible active finish for "${product.name}".`,
        );
      }

      const config = resolveProductFieldConfig(product);
      const candidateSpecs = flattenVariantSpecs({
        grade: values.grade,
        finish: values.finish,
        thicknessMm: values.thicknessMm,
        widthMm: values.widthMm,
        lengthMm: values.lengthMm,
        diameterMm: values.diameterMm,
        attributes: attrs,
      });
      const formSpecs = Object.fromEntries(
        Object.entries(candidateSpecs)
          .filter(([, value]) => value != null && typeof value !== "object")
          .map(([keyName, value]) => [keyName, String(value)]),
      );
      const pricingKeys = config
        ? activePricingMatchKeys(config, formSpecs)
        : Object.keys(formSpecs).filter((keyName) => String(formSpecs[keyName] ?? "").trim());
      const candidateFingerprint = buildNormalizedPricingFingerprint(
        candidateSpecs,
        pricingKeys,
        config,
      );
      const duplicates = product.variants.filter((variant) => {
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
          buildNormalizedPricingFingerprint(otherSpecs, pricingKeys, config) ===
          candidateFingerprint
        );
      });
      if (duplicates.length && input.isActive !== false) {
        throw new AppError(
          409,
          "DUPLICATE",
          "An active variant with these pricing specifications already exists.",
        );
      }

      const resolvedGrade = gradeCompat?.grade.name ?? values.grade;
      const resolvedFinish = finishCompat?.finish.name ?? values.finish;
      const displayName =
        clean(input.displayName) ??
        [
          product.name,
          values.grade,
          values.finish,
          values.thicknessMm && `${values.thicknessMm} mm`,
          values.widthMm && `W ${values.widthMm} mm`,
        ]
          .filter(Boolean)
          .join(" · ");
      const parsedSellingPrice =
        input.sellingPrice !== undefined
          ? input.sellingPrice.trim()
            ? new Prisma.Decimal(input.sellingPrice.trim())
            : null
          : null;
      if (input.sellingPrice !== undefined) {
        attrs.catalogSellingPrice =
          parsedSellingPrice != null ? parsedSellingPrice.toFixed(2) : null;
      }

      const variantId = uuidv7();
      const materialId = uuidv7();
      const sku = `${product.sku.slice(0, 20)}-V${variantId.slice(-6).toUpperCase()}`;
      await tx.materialMaster.create({
        data: {
          id: materialId,
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
          grade: resolvedGrade,
          thickness: asDecimal(values.thicknessMm),
          width: asDecimal(values.widthMm),
          length: asDecimal(values.lengthMm),
          diameter: asDecimal(values.diameterMm),
          purchaseAllowed: baseMaterial.purchaseAllowed,
          salesAllowed: baseMaterial.salesAllowed,
          manufacturingAllowed: baseMaterial.manufacturingAllowed,
          purchasePrice: baseMaterial.purchasePrice,
          sellingPrice: parsedSellingPrice,
          taxRate: baseMaterial.taxRate,
          specs: attrs as Prisma.InputJsonObject,
          active: input.isActive ?? true,
        },
      });
      await tx.productVariant.create({
        data: {
          id: variantId,
          plantId: product.plantId,
          productId: product.id,
          sku,
          displayName,
          materialMasterId: materialId,
          unitId: unit.id,
          ...values,
          grade: resolvedGrade,
          finish: resolvedFinish,
          gradeId: gradeCompat?.grade.id ?? null,
          finishId: finishCompat?.finish.id ?? null,
          attributes: attrs as Prisma.InputJsonObject,
          isActive: input.isActive ?? true,
          ...({ pricingFingerprint: candidateFingerprint } as object),
        } as Prisma.ProductVariantUncheckedCreateInput,
      });
      await audit(tx, {
        userId: session.userId,
        action: "product.variant.create",
        resource: "product_variant",
        resourceId: variantId,
      });
      return {
        id: variantId,
        displayName,
        sku,
        isActive: input.isActive ?? true,
        sellingPrice: parsedSellingPrice?.toString() ?? null,
      };
    },
  });
}
