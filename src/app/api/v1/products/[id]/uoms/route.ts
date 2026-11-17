import { jsonData, jsonError } from "@/lib/api";
import { primaryPlant, requirePermission } from "@/lib/access";
import { getAllowedUomsForProduct, getDefaultUomForProduct } from "@/modules/uom/service";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await requirePermission("lead.manage");
    const plantId = primaryPlant(session);
    const { id } = await ctx.params;
    const [allowed, defaultUom] = await Promise.all([
      getAllowedUomsForProduct(id, plantId),
      getDefaultUomForProduct(id, plantId),
    ]);
    return jsonData({ allowed, defaultUom });
  } catch (error) {
    return jsonError(error);
  }
}
