import type { SessionUser } from "@/lib/auth/session";
import { primaryPlant } from "@/lib/access";
import { AppError } from "@/lib/errors";
import { uuidv7 } from "@/lib/ids";
import { audit, runCommand } from "@/lib/inventory/post";
import { allow } from "@/modules/shared/allow";
import { listCategoryUomMappings } from "@/modules/uom/service";

export async function setCategoryUomMappings(
  session: SessionUser,
  productCategoryId: string,
  input: {
    mappings: { unitId: string; isDefault?: boolean; isActive?: boolean }[];
  },
  key: string | null,
) {
  allow(session, "plant.manage");
  const plantId = primaryPlant(session);
  return runCommand({
    userId: session.userId,
    route: "category.uoms.set",
    key,
    run: async (tx) => {
      const category = await tx.productCategory.findFirst({
        where: { id: productCategoryId, plantId },
      });
      if (!category) throw new AppError(404, "NOT_FOUND", "Category not found.");

      const unitIds = input.mappings.map((row) => row.unitId);
      const units = await tx.unitOfMeasure.findMany({
        where: { plantId, id: { in: unitIds }, isActive: true },
      });
      if (units.length !== new Set(unitIds).size) {
        throw new AppError(400, "VALIDATION", "One or more UOMs are invalid or inactive for this plant.");
      }

      const activeDefaults = input.mappings.filter((row) => (row.isActive ?? true) && row.isDefault);
      if (activeDefaults.length > 1) {
        throw new AppError(400, "VALIDATION", "Only one default UOM is allowed per category.");
      }

      // Replace strategy: deactivate removed, upsert provided
      const existing = await tx.productCategoryUom.findMany({
        where: { plantId, productCategoryId },
      });
      const incoming = new Set(unitIds);

      await tx.productCategoryUom.updateMany({
        where: { plantId, productCategoryId, isDefault: true },
        data: { isDefault: false },
      });

      for (const row of existing) {
        if (!incoming.has(row.unitId)) {
          await tx.productCategoryUom.update({
            where: { id: row.id },
            data: { isActive: false, isDefault: false },
          });
        }
      }

      let defaultAssigned = false;
      for (const mapping of input.mappings) {
        const isActive = mapping.isActive ?? true;
        const isDefault = Boolean(mapping.isDefault) && isActive && !defaultAssigned;
        if (isDefault) defaultAssigned = true;
        const found = existing.find((row) => row.unitId === mapping.unitId);
        if (found) {
          await tx.productCategoryUom.update({
            where: { id: found.id },
            data: { isActive, isDefault },
          });
        } else {
          await tx.productCategoryUom.create({
            data: {
              id: uuidv7(),
              plantId,
              productCategoryId,
              unitId: mapping.unitId,
              isActive,
              isDefault,
            },
          });
        }
      }

      if (!defaultAssigned) {
        const firstActive = input.mappings.find((row) => row.isActive !== false);
        if (firstActive) {
          await tx.productCategoryUom.updateMany({
            where: { plantId, productCategoryId, unitId: firstActive.unitId },
            data: { isDefault: true, isActive: true },
          });
        }
      }

      await audit(tx, {
        userId: session.userId,
        action: "category.uoms.set",
        resource: "product_category",
        resourceId: productCategoryId,
      });

      const rows = await listCategoryUomMappings(productCategoryId, plantId, tx);
      return {
        mappings: rows.map((row) => ({
          id: row.id,
          unitId: row.unitId,
          isDefault: row.isDefault,
          isActive: row.isActive,
          unit: {
            id: row.unit.id,
            name: row.unit.name,
            symbol: row.unit.symbol,
            unitType: row.unit.unitType,
            isActive: row.unit.isActive,
          },
        })),
      };
    },
  });
}
