import type { Prisma } from "@prisma/client";
import { hashPassword } from "@/lib/auth/password";
import { AppError } from "@/lib/errors";
import { uuidv7 } from "@/lib/ids";
import { createCustomerInTx } from "@/lib/masters";

type Tx = Prisma.TransactionClient;

function randomPortalPassword() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
  let password = "";
  for (let i = 0; i < 16; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

async function createPortalCustomerUser(
  tx: Tx,
  plantId: string,
  input: { email: string; name: string; phone?: string | null; customerId: string },
) {
  const role = await tx.role.findUnique({ where: { code: "customer" } });
  if (!role) throw new AppError(500, "INTERNAL", "Customer role is not configured.");

  const userId = uuidv7();
  await tx.user.create({
    data: {
      id: userId,
      email: input.email,
      name: input.name.trim(),
      phone: input.phone?.trim() || null,
      passwordHash: await hashPassword(randomPortalPassword()),
      customerId: input.customerId,
    },
  });
  await tx.userRole.create({ data: { userId, roleId: role.id } });
  await tx.userPlantAccess.create({ data: { userId, plantId } });
  return userId;
}

/**
 * Existing customers must be chosen from the lead-form dropdown (`customerId`).
 * New customers are created here; if the email is already registered, block both
 * portal-user and lead creation so the same email cannot become two customers.
 */
export async function resolveOrCreateCustomerForLead(
  tx: Tx,
  plantId: string,
  input: {
    customerId?: string;
    name: string;
    phone: string;
    email?: string | null;
  },
  auditUserId: string,
): Promise<string> {
  if (input.customerId) {
    const customer = await tx.customer.findFirst({ where: { id: input.customerId, plantId } });
    if (!customer) throw new AppError(400, "VALIDATION", "Customer not found.");
    return customer.id;
  }

  const email = input.email?.trim().toLowerCase() || "";
  const displayName = input.name.trim();
  const phone = input.phone.trim();

  if (email) {
    const existingUser = await tx.user.findFirst({
      where: { email, deletedAt: null },
      select: {
        id: true,
        customerId: true,
        customer: { select: { id: true, code: true, name: true, plantId: true } },
      },
    });
    if (existingUser) {
      const linked =
        existingUser.customer?.plantId === plantId ? existingUser.customer : null;
      throw new AppError(
        409,
        "DUPLICATE",
        linked
          ? `This email already belongs to customer ${linked.code} — ${linked.name}. Select that customer from the dropdown instead of creating a new one.`
          : "This email is already registered. Select the existing customer from the dropdown, or use a different email.",
      );
    }
  }

  const customer = await createCustomerInTx(
    tx,
    plantId,
    { name: displayName, phone },
    auditUserId,
  );

  if (email) {
    await createPortalCustomerUser(tx, plantId, {
      email,
      name: displayName,
      phone,
      customerId: customer.id,
    });
  }

  return customer.id;
}
