import { notFound } from "next/navigation";
import { DeskFormPage } from "@/components/desk";
import { LeadEditDeliveryForm } from "@/components/leads/lead-edit-delivery-form";
import { requirePage } from "@/lib/access";
import { leadDetail } from "@/modules/leads/queries";

function dateOnly(value: Date | null | undefined) {
  return value ? value.toISOString().slice(0, 10) : "";
}

export default async function EditLeadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requirePage("lead.manage");
  const { id } = await params;
  const lead = await leadDetail(id, session.plantIds);
  if (!lead) notFound();

  return (
    <DeskFormPage
      title="Edit lead"
      detail="Update per-product required and promised delivery dates."
      backHref={`/leads/${lead.id}`}
      boxed={false}
      wide
    >
      <LeadEditDeliveryForm
        leadId={lead.id}
        leadNumber={lead.leadNumber}
        items={lead.items.map((item) => ({
          id: item.id,
          label: item.product?.name ?? item.itemDescription ?? "Requested item",
          quantity: item.quantity.toString(),
          uom: item.uom,
          requiredDeliveryDate: dateOnly(item.requiredDeliveryDate ?? item.expectedDeliveryDate),
          promisedDeliveryDate: dateOnly(item.promisedDeliveryDate),
        }))}
      />
    </DeskFormPage>
  );
}
