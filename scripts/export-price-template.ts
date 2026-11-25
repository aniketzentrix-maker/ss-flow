/**
 * Read-only export: blank client price-list Excel template for active catalog products.
 *
 * Usage:
 *   npm run export:price-template
 *   npm run export:price-template -- --plant=PLANT-01
 *
 * Output: ./exports/price-list-template-YYYY-MM-DD.xlsx
 */
import fs from "node:fs";
import path from "node:path";
import {
  Workbook,
  type Borders,
  type Cell,
  type Fill,
  type Worksheet,
} from "exceljs";
import { prisma } from "../src/db";
import {
  isPricingSpecField,
  resolveProductFieldConfig,
  specFieldLabel,
  specFieldUnit,
  type ProductSpecField,
} from "../src/lib/domain/product-spec-fields";

/** How many blank rows (including the first) each product gets. */
const ROWS_PER_PRODUCT = 10;

const HEADER_FILL: Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1F4E79" },
};
const LOCKED_FILL: Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFD9D9D9" },
};
const NA_FILL: Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFE7E6E6" },
};
const UNLOCKED_FILL: Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFFFFFFF" },
};
const PRICE_MISSING_FILL: Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFFFFF99" },
};
const SUMMARY_FILL: Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFE2EFDA" },
};

const THIN_BORDER: Partial<Borders> = {
  top: { style: "thin", color: { argb: "FFB4B4B4" } },
  left: { style: "thin", color: { argb: "FFB4B4B4" } },
  bottom: { style: "thin", color: { argb: "FFB4B4B4" } },
  right: { style: "thin", color: { argb: "FFB4B4B4" } },
};

/** Preferred column order for pricing / dimension fields across all products. */
const SPEC_COLUMN_ORDER = [
  "grade",
  "finish",
  "thickness",
  "width",
  "length",
  "breadth",
  "diameter",
  "wireDiameterMm",
  "productForm",
  "finishOrCondition",
  "cutLengthMm",
  "decorativeSubtype",
  "cutProfile",
  "dimensions",
  "designReference",
  "stageOfManufacture",
  "utensilType",
] as const;

type CatalogProduct = {
  id: string;
  sku: string;
  name: string;
  gstPercent: string;
  unitSymbol: string;
  categoryName: string;
  subcategoryName: string;
  applicableKeys: Set<string>;
};

function parsePlantArg(argv: string[]): string | null {
  for (const arg of argv) {
    const match = /^--plant=(.+)$/i.exec(arg.trim());
    if (match?.[1]) return match[1].trim().toUpperCase();
  }
  const fromEnv = process.env.PLANT_CODE?.trim();
  return fromEnv ? fromEnv.toUpperCase() : null;
}

function todayStamp(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function colLetter(index1: number): string {
  let n = index1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function applicablePricingKeys(sku: string, name: string): Set<string> {
  const config = resolveProductFieldConfig({ sku, name });
  if (!config) {
    return new Set(["grade", "finish", "thickness"]);
  }
  return new Set(config.fields.filter(isPricingSpecField).map((field) => field.key));
}

function specHeader(key: string, fieldByKey: Map<string, ProductSpecField>): string {
  const field = fieldByKey.get(key);
  const label = field?.label ?? specFieldLabel(key);
  const unit = field?.unit ?? specFieldUnit(key);
  if (unit === "mm") return `${label} (mm)`;
  if (unit) return `${label} (${unit})`;
  return label;
}

function isNumericSpecKey(key: string, fieldByKey: Map<string, ProductSpecField>): boolean {
  const field = fieldByKey.get(key);
  if (field?.type === "number") return true;
  return ["thickness", "width", "length", "breadth", "diameter", "wireDiameterMm", "cutLengthMm"].includes(
    key,
  );
}

async function loadCatalog(plantCode: string | null) {
  const plants = await prisma.plant.findMany({
    select: { id: true, code: true, name: true },
    orderBy: { code: "asc" },
  });
  if (!plants.length) {
    throw new Error("No plants found in the database.");
  }

  const plant =
    (plantCode ? plants.find((p) => p.code.toUpperCase() === plantCode) : null) ?? plants[0]!;
  if (plantCode && plant.code.toUpperCase() !== plantCode) {
    throw new Error(`Plant code "${plantCode}" was not found. Available: ${plants.map((p) => p.code).join(", ")}`);
  }

  const [activeProducts, inactiveCount, grades, finishes] = await Promise.all([
    prisma.product.findMany({
      where: { plantId: plant.id, isActive: true },
      select: {
        id: true,
        sku: true,
        name: true,
        gstPercent: true,
        baseUnit: { select: { symbol: true } },
        category: {
          select: {
            name: true,
            code: true,
            parent: { select: { name: true, code: true } },
          },
        },
      },
      orderBy: [{ name: "asc" }, { sku: "asc" }],
    }),
    prisma.product.count({ where: { plantId: plant.id, isActive: false } }),
    prisma.gradeMaster.findMany({
      where: { plantId: plant.id, isActive: true },
      select: { name: true },
      orderBy: { name: "asc" },
    }),
    prisma.finishMaster.findMany({
      where: { plantId: plant.id, isActive: true },
      select: { name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const otherPlantActive = await prisma.product.count({
    where: { isActive: true, plantId: { not: plant.id } },
  });

  const catalog: CatalogProduct[] = activeProducts
    .map((p) => {
      const categoryName = p.category?.parent?.name ?? p.category?.name ?? "";
      const subcategoryName = p.category?.parent ? (p.category.name ?? "") : "";
      return {
        id: p.id,
        sku: p.sku,
        name: p.name,
        gstPercent: p.gstPercent?.toString() ?? "18",
        unitSymbol: p.baseUnit?.symbol?.toUpperCase() || "KG",
        categoryName,
        subcategoryName,
        applicableKeys: applicablePricingKeys(p.sku, p.name),
      };
    })
    .sort((a, b) => {
      const c = a.categoryName.localeCompare(b.categoryName, "en");
      if (c) return c;
      const s = a.subcategoryName.localeCompare(b.subcategoryName, "en");
      if (s) return s;
      return a.name.localeCompare(b.name, "en");
    });

  const uniqueGrades = [...new Set(grades.map((g) => g.name.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "en", { numeric: true }),
  );
  const uniqueFinishes = [...new Set(finishes.map((f) => f.name.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "en"),
  );

  return {
    plant,
    plants,
    catalog,
    inactiveSkipped: inactiveCount,
    otherPlantActiveSkipped: otherPlantActive,
    grades: uniqueGrades,
    finishes: uniqueFinishes,
  };
}

function collectSpecKeys(catalog: CatalogProduct[]): string[] {
  const present = new Set<string>();
  for (const product of catalog) {
    for (const key of product.applicableKeys) present.add(key);
  }
  const ordered = SPEC_COLUMN_ORDER.filter((key) => present.has(key));
  const extras = [...present].filter((key) => !SPEC_COLUMN_ORDER.includes(key as (typeof SPEC_COLUMN_ORDER)[number]));
  extras.sort((a, b) => a.localeCompare(b));
  return [...ordered, ...extras];
}

function buildFieldLookup(catalog: CatalogProduct[]): Map<string, ProductSpecField> {
  const map = new Map<string, ProductSpecField>();
  for (const product of catalog) {
    const config = resolveProductFieldConfig({ sku: product.sku, name: product.name });
    for (const field of config?.fields ?? []) {
      if (!map.has(field.key)) map.set(field.key, field);
    }
  }
  return map;
}

type ColMap = {
  productId: number;
  category: number;
  subcategory: number;
  productName: number;
  sku: number;
  unit: number;
  specs: Record<string, number>;
  price: number;
  remarks: number;
  status: number;
  last: number;
  firstUnlocked: number;
};

function buildColMap(specKeys: string[]): ColMap {
  let i = 1;
  const productId = i++;
  const category = i++;
  const subcategory = i++;
  const productName = i++;
  const sku = i++;
  const unit = i++;
  const firstUnlocked = i;
  const specs: Record<string, number> = {};
  for (const key of specKeys) {
    specs[key] = i++;
  }
  const price = i++;
  const remarks = i++;
  const status = i++;
  return {
    productId,
    category,
    subcategory,
    productName,
    sku,
    unit,
    specs,
    price,
    remarks,
    status,
    last: status,
    firstUnlocked,
  };
}

function styleLockedCell(cell: Cell, value: string | number) {
  cell.value = value;
  cell.fill = LOCKED_FILL;
  cell.protection = { locked: true };
  cell.border = THIN_BORDER;
  cell.alignment = { vertical: "middle", wrapText: true };
}

function styleNaCell(cell: Cell) {
  cell.value = "";
  cell.fill = NA_FILL;
  cell.protection = { locked: true };
  cell.border = THIN_BORDER;
}

function styleUnlockedCell(cell: Cell) {
  cell.value = "";
  cell.fill = UNLOCKED_FILL;
  cell.protection = { locked: false };
  cell.border = THIN_BORDER;
  cell.alignment = { vertical: "middle", wrapText: true };
}

async function buildWorkbook(input: Awaited<ReturnType<typeof loadCatalog>>) {
  const { catalog, grades, finishes, plant } = input;
  const specKeys = collectSpecKeys(catalog);
  const fieldByKey = buildFieldLookup(catalog);
  const cols = buildColMap(specKeys);
  const wb = new Workbook();
  wb.creator = "SS Flow";
  wb.created = new Date();

  const priceList = wb.addWorksheet("Price List", {
    views: [{ state: "frozen", xSplit: cols.firstUnlocked - 1, ySplit: 5 }],
    properties: { defaultRowHeight: 18 },
  });

  const instructions = wb.addWorksheet("Instructions", {
    views: [{ showGridLines: false }],
  });
  instructions.columns = [{ width: 110 }];

  const lists = wb.addWorksheet("Lists", { state: "hidden" });
  lists.getCell("A1").value = "Grade";
  lists.getCell("B1").value = "Finish";
  grades.forEach((name, idx) => {
    lists.getCell(idx + 2, 1).value = name;
  });
  finishes.forEach((name, idx) => {
    lists.getCell(idx + 2, 2).value = name;
  });
  const gradeRange =
    grades.length > 0 ? `Lists!$A$2:$A${grades.length + 1}` : `"304"`;
  const finishRange =
    finishes.length > 0 ? `Lists!$B$2:$B${finishes.length + 1}` : `"2B"`;

  const summaryRows = 4;
  const headerRowIndex = 5;
  const firstDataRow = 6;
  const totalDataRows = catalog.length * ROWS_PER_PRODUCT;
  const lastDataRow = firstDataRow + totalDataRows - 1;

  const headers: { col: number; title: string; width: number }[] = [
    { col: cols.productId, title: "Product ID (do not edit)", width: 14 },
    { col: cols.category, title: "Category", width: 22 },
    { col: cols.subcategory, title: "Subcategory", width: 18 },
    { col: cols.productName, title: "Product Name", width: 22 },
    { col: cols.sku, title: "SKU / Code", width: 26 },
    { col: cols.unit, title: "Unit (base UOM)", width: 14 },
  ];
  for (const key of specKeys) {
    headers.push({
      col: cols.specs[key]!,
      title: specHeader(key, fieldByKey),
      width: key === "designReference" || key === "dimensions" || key === "cutProfile" ? 22 : 16,
    });
  }
  headers.push({
    col: cols.price,
    title: "Price per Unit (Rs.) — excl. GST",
    width: 28,
  });
  headers.push({ col: cols.remarks, title: "Remarks", width: 28 });
  headers.push({ col: cols.status, title: "Row Status", width: 14 });

  // Summary band
  priceList.mergeCells(1, 1, 1, cols.last);
  priceList.getCell(1, 1).value =
    `SS Metals — Client Price List Template  |  Plant: ${plant.code} (${plant.name})  |  Generated: ${todayStamp()}`;
  priceList.getCell(1, 1).font = { bold: true, size: 13, color: { argb: "FF1F4E79" } };
  priceList.getCell(1, 1).alignment = { vertical: "middle", wrapText: true };

  priceList.mergeCells(2, 1, 2, cols.last);
  priceList.getCell(2, 1).value =
    "Fill only white cells. Grey = locked product info or N/A for that product. Yellow highlight = specs started but price missing. Price is per base Unit and excluding GST (GST is added on quotations).";
  priceList.getCell(2, 1).font = { italic: true, size: 10, color: { argb: "FF555555" } };

  const specColLetters = specKeys.map((key) => colLetter(cols.specs[key]!));
  const priceCol = colLetter(cols.price);
  const statusCol = colLetter(cols.status);

  // Live counts (formulas)
  priceList.getCell(3, 1).value = "Rows with any grade/finish/thickness filled:";
  priceList.getCell(3, 1).font = { bold: true };
  priceList.mergeCells(3, 2, 3, 3);
  // Row Status is derived from grade/finish/thickness/price — reuse it for live counts.
  priceList.getCell(3, 2).value = {
    formula: `COUNTIF(${statusCol}${firstDataRow}:${statusCol}${lastDataRow},"Complete")+COUNTIF(${statusCol}${firstDataRow}:${statusCol}${lastDataRow},"Price missing")`,
  };
  priceList.getCell(3, 2).fill = SUMMARY_FILL;
  priceList.getCell(3, 4).value = "Rows missing price:";
  priceList.getCell(3, 4).font = { bold: true };
  priceList.getCell(3, 5).value = {
    formula: `COUNTIF(${statusCol}${firstDataRow}:${statusCol}${lastDataRow},"Price missing")`,
  };
  priceList.getCell(3, 5).fill = SUMMARY_FILL;

  priceList.getCell(4, 1).value =
    `Products: ${catalog.length}  ·  Blank rows per product: ${ROWS_PER_PRODUCT}  ·  Total data rows: ${totalDataRows}  ·  GST on catalog rates: excluding (added later on quotation)`;
  priceList.getCell(4, 1).font = { size: 10 };

  for (let r = 1; r <= summaryRows; r++) {
    for (let c = 1; c <= cols.last; c++) {
      priceList.getCell(r, c).protection = { locked: true };
    }
  }

  const headerRow = priceList.getRow(headerRowIndex);
  headerRow.height = 28;
  for (const h of headers) {
    const cell = headerRow.getCell(h.col);
    cell.value = h.title;
    cell.fill = HEADER_FILL;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = THIN_BORDER;
    cell.protection = { locked: true };
    priceList.getColumn(h.col).width = h.width;
  }

  // Hide Product ID column
  priceList.getColumn(cols.productId).hidden = true;

  let rowIndex = firstDataRow;
  for (const product of catalog) {
    for (let spare = 0; spare < ROWS_PER_PRODUCT; spare++) {
      const row = priceList.getRow(rowIndex);
      styleLockedCell(row.getCell(cols.productId), product.id);
      styleLockedCell(row.getCell(cols.category), product.categoryName);
      styleLockedCell(row.getCell(cols.subcategory), product.subcategoryName || "—");
      styleLockedCell(row.getCell(cols.productName), product.name);
      styleLockedCell(row.getCell(cols.sku), product.sku);
      styleLockedCell(row.getCell(cols.unit), product.unitSymbol);

      for (const key of specKeys) {
        const cell = row.getCell(cols.specs[key]!);
        if (product.applicableKeys.has(key)) {
          styleUnlockedCell(cell);
          if (isNumericSpecKey(key, fieldByKey)) {
            cell.dataValidation = {
              type: "decimal",
              operator: "greaterThan",
              formulae: [0],
              allowBlank: true,
              showErrorMessage: true,
              errorTitle: "Positive number required",
              error: `${specHeader(key, fieldByKey)} must be a positive number (mm). Leave blank if not used.`,
              errorStyle: "error",
            };
          } else if (key === "grade") {
            cell.dataValidation = {
              type: "list",
              allowBlank: true,
              formulae: [gradeRange],
              showErrorMessage: true,
              errorStyle: "warning",
              errorTitle: "New grade?",
              error: "This grade is not in the master list. You can still keep it if it is a new grade.",
              promptTitle: "Grade",
              prompt: "Pick a grade or type a new one.",
              showInputMessage: true,
            };
          } else if (key === "finish") {
            cell.dataValidation = {
              type: "list",
              allowBlank: true,
              formulae: [finishRange],
              showErrorMessage: true,
              errorStyle: "warning",
              errorTitle: "New finish?",
              error: "This finish is not in the master list. You can still keep it if it is a new finish.",
              promptTitle: "Finish",
              prompt: "Pick a finish or type a new one.",
              showInputMessage: true,
            };
          }
        } else {
          styleNaCell(cell);
        }
      }

      const priceCell = row.getCell(cols.price);
      styleUnlockedCell(priceCell);
      priceCell.numFmt = "0.00";
      priceCell.dataValidation = {
        type: "decimal",
        operator: "greaterThan",
        formulae: [0],
        allowBlank: true,
        showErrorMessage: true,
        errorTitle: "Positive price required",
        error: "Price per unit must be a positive number (Rs.), excluding GST.",
        errorStyle: "error",
      };

      styleUnlockedCell(row.getCell(cols.remarks));

      const statusCell = row.getCell(cols.status);
      const pRef = `${priceCol}${rowIndex}`;
      const anySpecFilled =
        specColLetters.length > 0
          ? `OR(${specColLetters.map((letter) => `LEN(TRIM(${letter}${rowIndex}))>0`).join(",")})`
          : "FALSE";
      const allSpecsEmpty =
        specColLetters.length > 0
          ? `AND(${specColLetters.map((letter) => `LEN(TRIM(${letter}${rowIndex}))=0`).join(",")})`
          : "TRUE";
      statusCell.value = {
        formula: `IF(AND(${allSpecsEmpty},LEN(TRIM(${pRef}))=0),"",IF(AND(${anySpecFilled},LEN(TRIM(${pRef}))=0),"Price missing","Complete"))`,
      };
      statusCell.protection = { locked: true };
      statusCell.fill = LOCKED_FILL;
      statusCell.border = THIN_BORDER;
      statusCell.alignment = { vertical: "middle", horizontal: "center" };

      rowIndex += 1;
    }
  }

  // Conditional formatting: yellow price when any spec started but price empty.
  // Relative refs use the first data row; Excel adjusts per cell in the range.
  const cfAnySpec =
    specColLetters.length > 0
      ? `OR(${specColLetters.map((letter) => `LEN(TRIM(${letter}${firstDataRow}))>0`).join(",")})`
      : "FALSE";
  priceList.addConditionalFormatting({
    ref: `${priceCol}${firstDataRow}:${priceCol}${lastDataRow}`,
    rules: [
      {
        type: "expression",
        priority: 1,
        formulae: [`AND(${cfAnySpec},LEN(TRIM(${priceCol}${firstDataRow}))=0)`],
        style: {
          fill: PRICE_MISSING_FILL,
        },
      },
    ],
  });

  priceList.autoFilter = {
    from: { row: headerRowIndex, column: cols.category },
    to: { row: lastDataRow, column: cols.last },
  };

  priceList.pageSetup = {
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    paperSize: 9,
    printTitlesRow: `${headerRowIndex}:${headerRowIndex}`,
  };

  // Unlock entire unused rows below so client can insert/copy and still edit.
  const bufferEnd = lastDataRow + 50;
  for (let r = lastDataRow + 1; r <= bufferEnd; r++) {
    for (let c = cols.firstUnlocked; c <= cols.remarks; c++) {
      const cell = priceList.getCell(r, c);
      cell.protection = { locked: false };
    }
    for (let c = 1; c < cols.firstUnlocked; c++) {
      priceList.getCell(r, c).protection = { locked: true };
    }
    priceList.getCell(r, cols.status).protection = { locked: true };
  }

  await priceList.protect("", {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatColumns: true,
    formatRows: true,
    sort: true,
    autoFilter: true,
    insertRows: true,
    deleteRows: false,
    insertColumns: false,
    deleteColumns: false,
    pivotTables: false,
  });

  // Instructions sheet
  const instructionLines: Array<{ text: string; bold?: boolean }> = [
    { text: "How to fill this price list", bold: true },
    { text: "" },
    {
      text: "1. Fill only the white (unlocked) columns — Grade, Finish, Thickness, other size fields that apply, Price, and Remarks.",
    },
    {
      text: "   Hindi: Sirf white cells bhariye — Grade, Finish, Thickness, jo size fields applicable hain, Price aur Remarks.",
    },
    {
      text: "2. Each product already has 10 rows. If you need more combinations, copy a full product row (including the grey product columns) and paste below.",
    },
    {
      text: "   Hindi: Har product ke 10 rows pehle se hain. Zyada combinations ke liye poori product row copy-paste karein.",
    },
    {
      text: "3. Leave a row blank if that combination is not available. Do not delete the grey product columns.",
    },
    {
      text: "   Hindi: Jo combination available nahi hai us row ko khali chhod dein. Grey columns mat badliye.",
    },
    {
      text: "4. Thickness and size fields are in millimetres (mm). Enter numbers only (example: 0.50).",
    },
    {
      text: "   Hindi: Thickness aur sizes millimetre (mm) mein hain — sirf number likhein (jaise 0.50).",
    },
    {
      text: "5. Price per Unit is in Rs. for the Unit shown on that row (KG / PCS / etc.) and is EXCLUDING GST. GST is applied later on the quotation.",
    },
    {
      text: "   Hindi: Price base Unit ke hisaab se Rs. mein hai aur GST ke bina hai. GST quotation par alag se lagega.",
    },
    {
      text: "6. Do not change grey columns or the hidden Product ID column. Grey size cells mean that field does not apply to that product.",
    },
    {
      text: "   Hindi: Grey columns aur hidden Product ID mat badlein. Grey size cell ka matlab us product par woh field nahi lagti.",
    },
    {
      text: "7. Grade and Finish have dropdown suggestions. You may type a new value if it is missing from the list (Excel will warn, that is OK).",
    },
    {
      text: "   Hindi: Grade/Finish dropdown se choose karein; list mein na ho to naya type kar sakte hain (warning aayegi, theek hai).",
    },
    {
      text: "8. When finished, save this file and return it to SS Metals / Zentrix.",
    },
    {
      text: "   Hindi: File save karke wapas bhej dein.",
    },
    { text: "" },
    { text: "Live counts (from Price List sheet)", bold: true },
    {
      text: `Plant exported: ${plant.code} — ${plant.name}`,
    },
  ];

  instructionLines.forEach((line, idx) => {
    const cell = instructions.getCell(idx + 1, 1);
    cell.value = line.text;
    if (line.bold) cell.font = { bold: true, size: 13, color: { argb: "FF1F4E79" } };
  });

  const countsStart = instructionLines.length + 2;
  instructions.getCell(countsStart, 1).value = "Rows filled (Complete + Price missing):";
  instructions.getCell(countsStart, 2).value = {
    formula: `'Price List'!B3`,
  };
  instructions.getCell(countsStart + 1, 1).value = "Rows missing price:";
  instructions.getCell(countsStart + 1, 2).value = {
    formula: `'Price List'!E3`,
  };

  const exampleStart = countsStart + 3;
  instructions.getCell(exampleStart, 1).value = "EXAMPLE ONLY (do not copy into Price List as-is) — Coil priced three ways:";
  instructions.getCell(exampleStart, 1).font = { bold: true, color: { argb: "FF9C5700" } };
  instructions.getCell(exampleStart + 1, 1).value =
    "Product: Coil | Grade 304 | Finish 2B | Thickness 0.50 mm | Width 1000 mm | Unit KG | Price 20.00 (excl. GST)";
  instructions.getCell(exampleStart + 2, 1).value =
    "Same specs | Unit FT | Price 15.00 (excl. GST)  →  use a second row with the same product columns";
  instructions.getCell(exampleStart + 3, 1).value =
    "Same specs | Unit IN | Price 1.50 (excl. GST)  →  third row";
  for (let r = exampleStart + 1; r <= exampleStart + 3; r++) {
    instructions.getCell(r, 1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFFFF2CC" },
    };
  }

  instructions.getCell(exampleStart + 5, 1).value =
    `Products in this file: ${catalog.length}. Inactive products skipped: ${input.inactiveSkipped}. Other-plant active products not included: ${input.otherPlantActiveSkipped}.`;

  await instructions.protect("", {
    selectLockedCells: true,
    selectUnlockedCells: true,
  });

  return {
    wb,
    catalog,
    grades,
    finishes,
    specKeys,
    cols,
    headerRowIndex,
    firstDataRow,
    lastDataRow,
    totalDataRows,
  };
}

async function verifyWorkbook(
  filePath: string,
  expected: {
    productCount: number;
    totalDataRows: number;
    grades: string[];
    finishes: string[];
    specKeys: string[];
  },
) {
  const wb = new Workbook();
  await wb.xlsx.readFile(filePath);
  const priceList = wb.getWorksheet("Price List");
  const lists = wb.getWorksheet("Lists");
  const instructions = wb.getWorksheet("Instructions");
  if (!priceList || !lists || !instructions) {
    throw new Error("Verification failed: expected sheets missing.");
  }

  const headerRow = priceList.getRow(5);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell: Cell) => {
    headers.push(String(cell.value ?? ""));
  });

  const lockedSample: string[] = [];
  const unlockedSample: string[] = [];
  const sampleRow = priceList.getRow(6);
  sampleRow.eachCell({ includeEmpty: true }, (cell: Cell, colNumber: number) => {
    const title = String(headerRow.getCell(colNumber).value ?? `col${colNumber}`);
    if (cell.protection?.locked === false) unlockedSample.push(title);
    else lockedSample.push(title);
  });

  const gradeOptions: string[] = [];
  const finishOptions: string[] = [];
  let r = 2;
  while (lists.getCell(r, 1).value) {
    gradeOptions.push(String(lists.getCell(r, 1).value));
    r += 1;
  }
  r = 2;
  while (lists.getCell(r, 2).value) {
    finishOptions.push(String(lists.getCell(r, 2).value));
    r += 1;
  }

  const productIds = new Set<string>();
  for (let row = 6; row <= 5 + expected.totalDataRows; row++) {
    const id = String(priceList.getRow(row).getCell(1).value ?? "");
    if (id) productIds.add(id);
  }

  return {
    sheets: wb.worksheets.map((s: Worksheet) => ({ name: s.name, state: s.state })),
    productCount: productIds.size,
    totalDataRows: expected.totalDataRows,
    headers,
    lockedColumns: lockedSample,
    unlockedColumns: unlockedSample,
    gradeOptions,
    finishOptions,
    expectedGradesMatch: gradeOptions.join("|") === expected.grades.join("|"),
    expectedFinishesMatch: finishOptions.join("|") === expected.finishes.join("|"),
    specKeys: expected.specKeys,
  };
}

async function main() {
  const plantCode = parsePlantArg(process.argv.slice(2));
  const loaded = await loadCatalog(plantCode);
  const built = await buildWorkbook(loaded);

  const outDir = path.resolve(process.cwd(), "exports");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `price-list-template-${todayStamp()}.xlsx`);
  await built.wb.xlsx.writeFile(outPath);

  const verification = await verifyWorkbook(outPath, {
    productCount: loaded.catalog.length,
    totalDataRows: built.totalDataRows,
    grades: loaded.grades,
    finishes: loaded.finishes,
    specKeys: built.specKeys,
  });

  console.log(
    JSON.stringify(
      {
        output: outPath,
        plant: { code: loaded.plant.code, name: loaded.plant.name },
        productsExported: loaded.catalog.length,
        inactiveSkipped: loaded.inactiveSkipped,
        otherPlantActiveSkipped: loaded.otherPlantActiveSkipped,
        rowsPerProduct: ROWS_PER_PRODUCT,
        totalDataRows: built.totalDataRows,
        products: loaded.catalog.map((p) => ({
          sku: p.sku,
          name: p.name,
          category: p.categoryName,
          subcategory: p.subcategoryName,
          unit: p.unitSymbol,
          applicableSpecs: [...p.applicableKeys],
        })),
        verification,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
