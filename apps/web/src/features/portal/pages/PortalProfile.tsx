import { PhoneInput } from "../../../components/PhoneInput";
import { CityPicker, ProvincePicker } from "../../../components/PsgcFields";
import {
  usePortalMe,
  usePortalUpdateProfile,
  type PortalProfileUpdate,
} from "@loan/api-client";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  SkeletonCard,
  useToast,
} from "@loan/ui";
import { Lock, Save, UserCircle } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

/**
 * Self-service profile page. Members can edit contact + address fields
 * (phone, email, street address, city, province, postal code). Everything
 * else — names, date of birth, gov't ID, employment, income, KYC status —
 * is read-only here. Those fields require officer re-verification and a
 * separate workflow. Letting a member silently rewrite their own KYC
 * record would defeat the purpose of having KYC.
 */
export function PortalProfile() {
  const me = usePortalMe();
  const update = usePortalUpdateProfile();
  const toast = useToast();

  const [form, setForm] = useState<PortalProfileUpdate>({});

  // Hydrate the form once the customer record loads.
  useEffect(() => {
    if (me.data?.customer && Object.keys(form).length === 0) {
      const c = me.data.customer;
      setForm({
        phone: c.phone ?? "",
        email: c.email ?? "",
        address: c.address ?? "",
        city: c.city ?? "",
        province: c.province ?? "",
        postalCode: c.postalCode ?? "",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.data?.customer]);

  if (me.isLoading || !me.data) {
    return <SkeletonCard />;
  }

  const c = me.data.customer;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      // Only send non-empty fields. Empty email is allowed (clears it);
      // empty phone / address / city would be a validation error
      // server-side because those are required on the Customer row.
      const patch: PortalProfileUpdate = {};
      if (form.phone) patch.phone = form.phone;
      if (form.email !== undefined) patch.email = form.email || null;
      if (form.address) patch.address = form.address;
      if (form.city) patch.city = form.city;
      patch.province = form.province || null;
      patch.postalCode = form.postalCode || null;
      await update.mutateAsync(patch);
      toast.success("Profile updated");
    } catch (err) {
      toast.error((err as Error).message ?? "Could not update");
    }
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserCircle className="h-4 w-4 text-info" />
            My profile
          </CardTitle>
        </CardHeader>
        <CardContent>
          {/* Read-only identity block. These fields don't have inputs
              because changing them requires officer re-verification. */}
          <div className="rounded-md border border-default bg-surface-2 p-3 mb-4 space-y-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="text-sm font-medium">
                {c.firstName} {c.lastName}
              </div>
              <KycBadge status={c.kycStatus} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
              <ReadOnlyField
                label="Date of birth"
                value={c.dateOfBirth.slice(0, 10)}
              />
              <ReadOnlyField
                label="Gov't ID"
                value={`${c.governmentIdType} · ${c.governmentIdNumber}`}
              />
              <ReadOnlyField
                label="Employment"
                value={`${c.employmentStatus.replace("_", " ").toLowerCase()}${
                  c.employerName ? ` · ${c.employerName}` : ""
                }`}
              />
              <ReadOnlyField
                label="Monthly income"
                value={`₱${Number(c.monthlyIncome).toLocaleString()}`}
              />
            </div>
            <p className="text-[10px] text-fg-subtle flex items-center gap-1 pt-1 border-t border-default">
              <Lock className="h-3 w-3" />
              These fields require a branch visit to update. Visit your
              cooperative office with the supporting documents.
            </p>
          </div>

          {/* Editable contact + address block */}
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Phone</Label>
                <PhoneInput
                  value={form.phone ?? ""}
                  onChange={(v) => setForm((f) => ({ ...f, phone: v }))}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label>Email</Label>
                <Input
                  type="email"
                  value={form.email ?? ""}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, email: e.target.value }))
                  }
                  placeholder="optional"
                />
              </div>
              <div className="space-y-1 md:col-span-2">
                <Label>Street address</Label>
                <Input
                  value={form.address ?? ""}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, address: e.target.value }))
                  }
                  required
                />
              </div>
              <div className="space-y-1">
                <Label>Province</Label>
                <ProvincePicker
                  value={form.province ?? ""}
                  onChange={(v) =>
                    // Changing province doesn't clear the city: a
                    // borrower correcting one field shouldn't lose the
                    // other, and the city list still contains it.
                    setForm((f) => ({ ...f, province: v }))
                  }
                />
              </div>
              <div className="space-y-1">
                <Label>City</Label>
                <CityPicker
                  province={form.province}
                  value={form.city ?? ""}
                  onChange={(v) => setForm((f) => ({ ...f, city: v }))}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label>Postal code</Label>
                <Input
                  value={form.postalCode ?? ""}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, postalCode: e.target.value }))
                  }
                />
              </div>
            </div>
            <div className="flex items-center justify-end">
              <Button type="submit" loading={update.isPending}>
                {!update.isPending && <Save className="h-4 w-4" />}
                Save changes
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
        {label}
      </div>
      <div className="font-mono text-fg truncate">{value}</div>
    </div>
  );
}

function KycBadge({ status }: { status: string }) {
  const map: Record<
    string,
    { variant: "muted" | "warning" | "success" | "danger"; label: string }
  > = {
    NONE: { variant: "muted", label: "KYC not started" },
    PENDING: { variant: "warning", label: "KYC pending" },
    VERIFIED: { variant: "success", label: "KYC verified" },
    REJECTED: { variant: "danger", label: "KYC rejected" },
  };
  const m = map[status] ?? map.NONE!;
  return <Badge variant={m.variant}>{m.label}</Badge>;
}
