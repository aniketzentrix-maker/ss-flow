import { prisma } from "../src/db";
import { ensureCategoryUoms } from "../src/modules/uom/ensure-category-uoms";

async function main() {
  const report = await ensureCategoryUoms(prisma);
  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
