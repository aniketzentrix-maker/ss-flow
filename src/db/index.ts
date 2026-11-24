import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaUrl?: string;
};

/** `channel_binding=require` often breaks Node/pg on Windows against Neon pooler. */
export function normalizeDatabaseUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  let next = url.replace(/([?&])channel_binding=require(&|$)/g, (_, sep, amp) =>
    amp === "&" ? sep : "",
  );
  next = next.replace(/\?&/, "?").replace(/[?&]$/, "");
  return next;
}

function currentClient() {
  const url = normalizeDatabaseUrl(process.env.DATABASE_URL);
  if (!globalForPrisma.prisma || globalForPrisma.prismaUrl !== url) {
    void globalForPrisma.prisma?.$disconnect();
    globalForPrisma.prisma = new PrismaClient({
      datasources: { db: { url } },
    });
    globalForPrisma.prismaUrl = url;
  }
  return globalForPrisma.prisma;
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = currentClient();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
