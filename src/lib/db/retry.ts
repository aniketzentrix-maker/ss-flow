import { Prisma } from "@prisma/client";

const UNREACHABLE = new Set(["P1001", "P1002", "P1017"]);

export function isDbUnreachable(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  if (error instanceof Prisma.PrismaClientKnownRequestError && UNREACHABLE.has(error.code)) {
    return true;
  }
  if (error && typeof error === "object" && "code" in error) {
    return UNREACHABLE.has(String((error as { code: string }).code));
  }
  return false;
}

/** Retry when Neon (or the network) is waking up — common on first request after idle. */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  opts?: { attempts?: number; delayMs?: number },
): Promise<T> {
  const attempts = opts?.attempts ?? 4;
  const delayMs = opts?.delayMs ?? 2_500;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (!isDbUnreachable(error) || i === attempts - 1) throw error;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw last;
}