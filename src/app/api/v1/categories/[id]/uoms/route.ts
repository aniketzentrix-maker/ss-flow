import { assertSameOrigin, idempotencyKey, jsonData, jsonError, readJson } from "@/lib/api";
import { primaryPlant, requirePermission } from "@/lib/access";
import { AppError } from "@/lib/errors";
import { categoryUomsSetSchema } from "@/lib/schemas";
import { setCategoryUomMappings } from "@/modules/uom/commands";
import { getActiveUoms, listCategoryUomMappings } from "@/modules/uom/service";
import { getProductCategory } from "@/modules/masters/categories";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const session = await requirePermission("plant.manage");
    const plantId = primaryPlant(session);
    const { id } = await context.params;
    const category = await getProductCategory(id, session.plantIds);
    if (!category) throw new AppError(404, "NOT_FOUND", "Category was not found.");
    const [mappings, units] = await Promise.all([
      listCategoryUomMappings(id, plantId),
      getActiveUoms(plantId),
    ]);
    return jsonData({
      mappings: mappings.map((row) => ({
        id: row.id,
        unitId: row.unitId,
        isDefault: row.isDefault,
        isActive: row.isActive,
        unit: row.unit,
      })),
      units,
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    const session = await requirePermission("plant.manage");
    const { id } = await context.params;
    const body = await readJson(request, categoryUomsSetSchema);
    const result = await setCategoryUomMappings(session, id, body, idempotencyKey(request));
    return jsonData(result);
  } catch (error) {
    return jsonError(error);
  }
}
