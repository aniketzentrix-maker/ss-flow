/** Allowed GST slabs for catalog products and quotation lines. */
export const PRODUCT_GST_SLABS = ["5", "18"] as const;
export type ProductGstSlab = (typeof PRODUCT_GST_SLABS)[number];

export function normalizeProductGst(value: string | number | null | undefined): ProductGstSlab {
  const raw = String(value ?? "").trim();
  const num = Number(raw);
  if (num === 5) return "5";
  if (num === 18) return "18";
  return "18";
}

export function isProductGstSlab(value: string): value is ProductGstSlab {
  return PRODUCT_GST_SLABS.includes(value as ProductGstSlab);
}
