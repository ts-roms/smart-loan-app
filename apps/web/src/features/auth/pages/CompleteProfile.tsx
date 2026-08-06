import { PhoneInput } from "../../../components/PhoneInput";
import {
  BarangayPicker,
  CityPicker,
  ProvincePicker,
} from "../../../components/PsgcFields";
import {
  useCompleteProfile,
  type CompleteProfileInput,
} from "@loan/api-client";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  useToast,
} from "@loan/ui";
import { Briefcase, IdCard, LogOut, MapPin, User } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";

import { useAuth } from "../../../providers/auth";

/**
 * Profile completion — the screen a self-registered borrower cannot
 * get past.
 *
 * Sign-up asks for three fields; this asks for everything a Customer
 * row requires, because until that row exists the account is inert:
 * `resolveCustomerId` refuses every portal endpoint for a CUSTOMER
 * with no `customerId`. So this isn't a prompt to fill in later, it's
 * the second half of registration, and App renders it in place of the
 * portal rather than alongside it.
 *
 * Every field here is a NOT NULL column on Customer. Optional extras
 * (spouse, hire dates, tenure) are left to the portal profile page —
 * the aim is the shortest form that produces a valid borrower record,
 * not a complete one.
 */
export function CompleteProfilePage() {
  const { user, signOut, updateUser } = useAuth();
  const complete = useCompleteProfile();
  const toast = useToast();

  const [form, setForm] = useState<CompleteProfileInput>({
    firstName: "",
    lastName: "",
    dateOfBirth: "",
    phone: "",
    address: "",
    city: "",
    governmentIdType: "NATIONAL_ID",
    governmentIdNumber: "",
    employmentStatus: "EMPLOYED",
    monthlyIncome: 0,
  });

  const set = <K extends keyof CompleteProfileInput>(
    key: K,
    value: CompleteProfileInput[K],
  ) => setForm((f) => ({ ...f, [key]: value }));

  // UNEMPLOYED / RETIRED / STUDENT have no employer to name, and asking
  // anyway invites "N/A" in a column reports read.
  const employed =
    form.employmentStatus === "EMPLOYED" ||
    form.employmentStatus === "SELF_EMPLOYED" ||
    form.employmentStatus === "FREELANCE";

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await complete.mutateAsync({
        ...form,
        // Drop blanks rather than sending empty strings — the server
        // treats these as optional, and "" would land in the database
        // as a present-but-meaningless value.
        middleName: form.middleName || undefined,
        suffix: form.suffix || undefined,
        secondaryPhone: form.secondaryPhone || undefined,
        addressLine2: form.addressLine2 || undefined,
        barangay: form.barangay || undefined,
        province: form.province || undefined,
        postalCode: form.postalCode || undefined,
        employerName: employed ? form.employerName || undefined : undefined,
        jobTitle: employed ? form.jobTitle || undefined : undefined,
      });
      // The response carries the now-populated customerId. Writing it
      // back here is what lifts the gate — without it the app would
      // keep rendering this form until the next full reload.
      updateUser(res.user);
      toast.success("Profile complete. Welcome aboard.");
    } catch (err) {
      toast.error((err as Error).message ?? "Could not save your profile");
    }
  };

  return (
    <div className="min-h-screen overflow-y-auto p-4 py-10">
      <Card className="w-full max-w-3xl mx-auto">
        <CardHeader>
          <CardTitle>Complete your profile</CardTitle>
          <p className="text-sm text-fg-muted mt-1">
            We need a few details before you can apply for a loan. This is a
            one-time step.
          </p>
          {user && (
            <p className="text-xs text-fg-subtle mt-2">
              Signed in as {user.email} ·{" "}
              <button
                type="button"
                onClick={signOut}
                className="underline inline-flex items-center gap-1"
              >
                <LogOut className="h-3 w-3" /> Sign out
              </button>
            </p>
          )}
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-6">
            <Section icon={User} title="Personal">
              <Field label="First name" required>
                <Input
                  value={form.firstName}
                  onChange={(e) => set("firstName", e.target.value)}
                  required
                />
              </Field>
              <Field label="Middle name">
                <Input
                  value={form.middleName ?? ""}
                  onChange={(e) => set("middleName", e.target.value)}
                />
              </Field>
              <Field label="Last name" required>
                <Input
                  value={form.lastName}
                  onChange={(e) => set("lastName", e.target.value)}
                  required
                />
              </Field>
              <Field label="Suffix" hint="Jr, Sr, III">
                <Input
                  value={form.suffix ?? ""}
                  onChange={(e) => set("suffix", e.target.value)}
                />
              </Field>
              <Field label="Date of birth" required>
                <Input
                  type="date"
                  // Guards the obvious mistake client-side; the server
                  // rejects future dates regardless.
                  max={new Date().toISOString().slice(0, 10)}
                  value={form.dateOfBirth}
                  onChange={(e) => set("dateOfBirth", e.target.value)}
                  required
                />
              </Field>
              <Field label="Civil status">
                <SelectField
                  value={form.civilStatus ?? ""}
                  onChange={(v) =>
                    set(
                      "civilStatus",
                      (v || undefined) as CompleteProfileInput["civilStatus"],
                    )
                  }
                  options={[
                    ["", "Select…"],
                    ["SINGLE", "Single"],
                    ["MARRIED", "Married"],
                    ["WIDOWED", "Widowed"],
                    ["SEPARATED", "Separated"],
                    ["ANNULLED", "Annulled"],
                    ["DIVORCED", "Divorced"],
                  ]}
                />
              </Field>
            </Section>

            <Section icon={MapPin} title="Contact and address">
              <Field label="Mobile number" required>
                <PhoneInput
                  value={form.phone}
                  onChange={(v) => set("phone", v)}
                  required
                />
              </Field>
              <Field label="Alternate number">
                <PhoneInput
                  value={form.secondaryPhone ?? ""}
                  onChange={(v) => set("secondaryPhone", v)}
                  placeholder="Optional"
                  optional
                />
              </Field>
              <Field
                label="Contact email"
                hint={`Defaults to ${user?.email ?? "your login email"}`}
              >
                <Input
                  type="email"
                  value={form.email ?? ""}
                  onChange={(e) => set("email", e.target.value)}
                />
              </Field>
              <Field label="Street address" required>
                <Input
                  value={form.address}
                  onChange={(e) => set("address", e.target.value)}
                  required
                />
              </Field>
              <Field label="Address line 2" hint="Unit, building, subdivision">
                <Input
                  value={form.addressLine2 ?? ""}
                  onChange={(e) => set("addressLine2", e.target.value)}
                />
              </Field>
              <Field label="Province">
                <ProvincePicker
                  value={form.province ?? ""}
                  onChange={(v) => set("province", v)}
                />
              </Field>
              <Field label="City or municipality" required>
                <CityPicker
                  province={form.province}
                  value={form.city}
                  onChange={(v) => set("city", v)}
                  required
                />
              </Field>
              <Field label="Barangay">
                <BarangayPicker
                  province={form.province}
                  city={form.city}
                  value={form.barangay ?? ""}
                  onChange={(v) => set("barangay", v)}
                />
              </Field>
              <Field label="Postal code">
                <Input
                  inputMode="numeric"
                  value={form.postalCode ?? ""}
                  onChange={(e) => set("postalCode", e.target.value)}
                />
              </Field>
            </Section>

            <Section icon={IdCard} title="Government ID">
              <Field label="ID type" required>
                <SelectField
                  value={form.governmentIdType}
                  onChange={(v) =>
                    set(
                      "governmentIdType",
                      v as CompleteProfileInput["governmentIdType"],
                    )
                  }
                  options={[
                    ["NATIONAL_ID", "National ID"],
                    ["PASSPORT", "Passport"],
                    ["DRIVERS_LICENSE", "Driver's licence"],
                    ["SSS", "SSS"],
                    ["TIN", "TIN"],
                    ["OTHER", "Other"],
                  ]}
                />
              </Field>
              <Field label="ID number" required>
                <Input
                  value={form.governmentIdNumber}
                  onChange={(e) => set("governmentIdNumber", e.target.value)}
                  required
                />
              </Field>
            </Section>

            <Section icon={Briefcase} title="Employment and income">
              <Field label="Employment status" required>
                <SelectField
                  value={form.employmentStatus}
                  onChange={(v) =>
                    set(
                      "employmentStatus",
                      v as CompleteProfileInput["employmentStatus"],
                    )
                  }
                  options={[
                    ["EMPLOYED", "Employed"],
                    ["SELF_EMPLOYED", "Self-employed"],
                    ["FREELANCE", "Freelance or contract"],
                    ["UNEMPLOYED", "Unemployed"],
                    ["RETIRED", "Retired"],
                    ["STUDENT", "Student"],
                  ]}
                />
              </Field>
              <Field
                label="Monthly income"
                required
                hint="Enter 0 if you have none"
              >
                <Input
                  inputMode="decimal"
                  value={String(form.monthlyIncome)}
                  onChange={(e) =>
                    set("monthlyIncome", Number(e.target.value) || 0)
                  }
                  required
                />
              </Field>
              {employed && (
                <>
                  <Field label="Employer">
                    <Input
                      value={form.employerName ?? ""}
                      onChange={(e) => set("employerName", e.target.value)}
                    />
                  </Field>
                  <Field label="Job title">
                    <Input
                      value={form.jobTitle ?? ""}
                      onChange={(e) => set("jobTitle", e.target.value)}
                    />
                  </Field>
                </>
              )}
            </Section>

            <div className="flex justify-end pt-2">
              <Button type="submit" loading={complete.isPending}>
                Save and continue
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof User;
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-3 text-xs uppercase tracking-wide text-fg-subtle">
        <Icon className="h-3.5 w-3.5" />
        {title}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="space-y-1 block">
      <span className="text-sm">
        {label}
        {required && <span className="text-info"> *</span>}
      </span>
      {children}
      {hint && <span className="text-[11px] text-fg-subtle block">{hint}</span>}
    </label>
  );
}

/**
 * Native select styled to match the Input component. The UI kit has no
 * select primitive, and the rest of the app reaches for a plain
 * `<select>` in the same situation.
 */
function SelectField({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full bg-surface-2 border border-default rounded-md px-3 py-2 text-sm"
    >
      {options.map(([v, label]) => (
        <option key={v} value={v} className="bg-surface-2 text-fg">
          {label}
        </option>
      ))}
    </select>
  );
}
