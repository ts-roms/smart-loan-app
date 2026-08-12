import type {
  CivilStatus,
  CustomerCreateInput,
  Gender,
  Sex,
} from "@loan/shared-types";
import {
  PSGC_REGIONS,
  citiesFor,
  provincesForRegion,
  regionHasProvinces,
  todayLocalISO,
  type PsgcRegion,
} from "@loan/shared-utils";
import {
  Button,
  DatePicker,
  DialogBody,
  Field,
  Input,
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from "@loan/ui";
import { useMemo, type FormEvent } from "react";

import { PhoneInput } from "../../../components/PhoneInput";
import { BarangayPicker, SuggestInput } from "../../../components/PsgcFields";

/**
 * Shared sectioned customer-profile form used by both the create flow
 * (`NewCustomerDialog`) and the edit flow (`EditCustomerDialog`).
 *
 * Why one shared form: both flows collect the same ~30 fields with the
 * same conditional logic (spouse appears when married, employer appears
 * for working statuses, region picker cascades into province). Keeping
 * them in lockstep means a field added in one place automatically
 * appears in the other.
 *
 * The form is a pure controlled component — caller owns the state
 * (typically a `useState<CustomerCreateInput>`) and the submit handler.
 * That avoids a hidden form-state library and keeps the dialog
 * wrapper free to handle save semantics (create vs. update) however
 * it likes.
 */
export interface CustomerProfileFormProps {
  form: CustomerCreateInput;
  setForm: React.Dispatch<React.SetStateAction<CustomerCreateInput>>;
  onSubmit: () => void | Promise<void>;
  /** Disables Save while a mutation is in flight. */
  submitting?: boolean;
  /** Button label, e.g. "Create customer" or "Save changes". */
  submitLabel: string;
  /** Cancel callback — closes the parent dialog. */
  onCancel: () => void;
  /** Optional pre-form slot — used by NewCustomerDialog to inject the IdOcrCard. */
  topSlot?: React.ReactNode;
  /** Optional post-form slot — used to inject a KYC reminder, etc. */
  bottomSlot?: React.ReactNode;
}

export function CustomerProfileForm({
  form,
  setForm,
  onSubmit,
  submitting,
  submitLabel,
  onCancel,
  topSlot,
  bottomSlot,
}: CustomerProfileFormProps) {
  const toast = useToast();

  const set = <K extends keyof CustomerCreateInput>(
    key: K,
    val: CustomerCreateInput[K],
  ) => setForm((f) => ({ ...f, [key]: val }));

  // Conditional sections — keep the form light by only rendering the
  // spouse + employer blocks when the relevant status calls for them.
  const isMarried = form.civilStatus === "MARRIED";
  const needsEmployer =
    form.employmentStatus === "EMPLOYED" ||
    form.employmentStatus === "SELF_EMPLOYED" ||
    form.employmentStatus === "FREELANCE";

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (isMarried && !form.spouseName?.trim()) {
      toast.error("Spouse name is required when civil status is MARRIED.");
      return;
    }
    if (needsEmployer && !form.employerName?.trim()) {
      toast.error(
        "Company / employer name is required for this employment status.",
      );
      return;
    }
    await onSubmit();
  };

  return (
    // Fills the dialog and owns the scrolling itself: the body scrolls
    // between a header the parent keeps in place and the action row
    // below. Scrolling the whole dialog instead took the title away
    // with the content, and left the sticky action row floating over
    // fields it didn't fully cover.
    <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
      <DialogBody className="space-y-5">
        {topSlot}

        {/* ── Identity ─────────────────────────────────────────────── */}
        <Section title="Identity">
          <Grid>
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
            <Field label="Suffix (Jr / Sr / III)">
              <Input
                value={form.suffix ?? ""}
                onChange={(e) => set("suffix", e.target.value)}
                maxLength={20}
              />
            </Field>
            <Field label="Date of birth" required>
              <DatePicker
                value={form.dateOfBirth}
                onChange={(v) => set("dateOfBirth", v)}
                max={todayLocalISO()}
                placeholder="Date of birth"
              />
            </Field>
            <Field label="Gender">
              <EnumSelect<Gender>
                value={form.gender}
                onChange={(v) => set("gender", v)}
                options={[
                  { value: "MALE", label: "Male" },
                  { value: "FEMALE", label: "Female" },
                  { value: "NON_BINARY", label: "Non-binary" },
                  { value: "PREFER_NOT_TO_SAY", label: "Prefer not to say" },
                ]}
              />
            </Field>
            <Field label="Sex">
              <EnumSelect<Sex>
                value={form.sex}
                onChange={(v) => set("sex", v)}
                options={[
                  { value: "MALE", label: "Male" },
                  { value: "FEMALE", label: "Female" },
                  { value: "INTERSEX", label: "Intersex" },
                ]}
              />
            </Field>
            <Field label="Civil status">
              <EnumSelect<CivilStatus>
                value={form.civilStatus}
                onChange={(v) => set("civilStatus", v)}
                options={[
                  { value: "SINGLE", label: "Single" },
                  { value: "MARRIED", label: "Married" },
                  { value: "WIDOWED", label: "Widowed" },
                  { value: "SEPARATED", label: "Separated" },
                  { value: "ANNULLED", label: "Annulled" },
                  { value: "DIVORCED", label: "Divorced" },
                ]}
              />
            </Field>
          </Grid>
        </Section>

        {/* ── Spouse (conditional) ─────────────────────────────────── */}
        {isMarried && (
          <Section title="Spouse details">
            <Grid>
              <Field
                label="Spouse full name"
                required
                className="sm:col-span-2"
              >
                <Input
                  value={form.spouseName ?? ""}
                  onChange={(e) => set("spouseName", e.target.value)}
                  required
                />
              </Field>
              <Field label="Spouse date of birth">
                <DatePicker
                  value={form.spouseDateOfBirth ?? ""}
                  onChange={(v) => set("spouseDateOfBirth", v)}
                  max={todayLocalISO()}
                />
              </Field>
              <Field label="Spouse contact">
                <PhoneInput
                  value={form.spouseContact ?? ""}
                  onChange={(v) => set("spouseContact", v)}
                  optional
                />
              </Field>
              <Field label="Spouse occupation" className="sm:col-span-2">
                <Input
                  value={form.spouseOccupation ?? ""}
                  onChange={(e) => set("spouseOccupation", e.target.value)}
                />
              </Field>
            </Grid>
          </Section>
        )}

        {/* ── Contact ──────────────────────────────────────────────── */}
        <Section title="Contact">
          <Grid>
            <Field label="Primary phone" required>
              <PhoneInput
                value={form.phone}
                onChange={(v) => set("phone", v)}
                required
              />
            </Field>
            <Field label="Secondary phone">
              <PhoneInput
                value={form.secondaryPhone ?? ""}
                onChange={(v) => set("secondaryPhone", v)}
                placeholder="Optional"
                optional
              />
            </Field>
            <Field label="Email" required className="sm:col-span-2">
              <Input
                type="email"
                value={form.email ?? ""}
                onChange={(e) => set("email", e.target.value)}
                placeholder="customer@example.com"
                required
              />
            </Field>
          </Grid>
        </Section>

        {/* ── Address ──────────────────────────────────────────────── */}
        <Section title="Address">
          <AddressBlock
            region={form.region}
            province={form.province}
            city={form.city}
            barangay={form.barangay}
            address={form.address}
            addressLine2={form.addressLine2}
            postalCode={form.postalCode}
            onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
          />
        </Section>

        {/* ── Government ID ────────────────────────────────────────── */}
        <Section title="Government ID">
          <Grid>
            <Field label="ID type" required>
              <EnumSelect
                value={form.governmentIdType}
                onChange={(v) => set("governmentIdType", v ?? "NATIONAL_ID")}
                options={[
                  { value: "PASSPORT", label: "Passport" },
                  { value: "DRIVERS_LICENSE", label: "Driver's License" },
                  { value: "NATIONAL_ID", label: "National ID (PhilSys)" },
                  { value: "SSS", label: "SSS" },
                  { value: "TIN", label: "TIN" },
                  { value: "OTHER", label: "Other" },
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
          </Grid>
        </Section>

        {/* ── Employment ───────────────────────────────────────────── */}
        <Section title="Employment">
          <Grid>
            <Field label="Employment status" required>
              <EnumSelect
                value={form.employmentStatus}
                onChange={(v) => set("employmentStatus", v ?? "EMPLOYED")}
                options={[
                  { value: "EMPLOYED", label: "Employed" },
                  { value: "SELF_EMPLOYED", label: "Self-employed" },
                  { value: "FREELANCE", label: "Freelance / Contract" },
                  { value: "UNEMPLOYED", label: "Unemployed" },
                  { value: "RETIRED", label: "Retired" },
                  { value: "STUDENT", label: "Student" },
                ]}
              />
            </Field>
            <Field label="Monthly income (₱)" required>
              <Input
                type="number"
                min={0}
                value={form.monthlyIncome}
                onChange={(e) => set("monthlyIncome", Number(e.target.value))}
                required
              />
            </Field>
            {needsEmployer && (
              <>
                <Field
                  label="Company / Employer"
                  required
                  className="sm:col-span-2"
                >
                  <Input
                    value={form.employerName ?? ""}
                    onChange={(e) => set("employerName", e.target.value)}
                    required
                  />
                </Field>
                <Field label="Job title">
                  <Input
                    value={form.jobTitle ?? ""}
                    onChange={(e) => set("jobTitle", e.target.value)}
                  />
                </Field>
                <Field label="Position / Designation">
                  <Input
                    value={form.position ?? ""}
                    onChange={(e) => set("position", e.target.value)}
                  />
                </Field>
                <Field label="Hire date">
                  <DatePicker
                    value={form.hireDate ?? ""}
                    onChange={(v) => set("hireDate", v)}
                    max={todayLocalISO()}
                  />
                </Field>
                <Field label="Regularization date">
                  <DatePicker
                    value={form.regularizationDate ?? ""}
                    onChange={(v) => set("regularizationDate", v)}
                    max={todayLocalISO()}
                  />
                </Field>
                <Field label="Years at current job">
                  <Input
                    type="number"
                    min={0}
                    step="0.5"
                    value={form.yearsAtCurrentJob ?? ""}
                    onChange={(e) =>
                      set(
                        "yearsAtCurrentJob",
                        e.target.value === ""
                          ? undefined
                          : Number(e.target.value),
                      )
                    }
                  />
                </Field>
              </>
            )}
          </Grid>
        </Section>

        {bottomSlot}
      </DialogBody>

      {/* Outside the scroll area, so it's always reachable without
          hiding anything. */}
      <div className="flex shrink-0 justify-end gap-2 border-t border-default px-6 py-3">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

// ─── Address block ───────────────────────────────────────────────────

/**
 * Cascading region → province → city picker over the full PSGC.
 *
 * The city list narrows as you go but is never empty: with a province
 * it's that province plus the region's independent cities, with only a
 * region it's the whole region, and with neither it's the country. A
 * dropdown that offers nothing until you fill in two other fields is
 * how people end up typing free text that no report can group.
 *
 * NCR has no provinces — its cities sit directly under the region — so
 * the province field says so instead of sitting empty and broken.
 *
 * Barangay suggestions load on demand once the city resolves — all
 * 42,046 of them exist, sharded by region, so nothing is bundled for
 * the forms that never ask.
 */
function AddressBlock({
  region,
  province,
  city,
  barangay,
  address,
  addressLine2,
  postalCode,
  onChange,
}: {
  region: string | undefined;
  province: string | undefined;
  city: string;
  barangay: string | undefined;
  address: string;
  addressLine2: string | undefined;
  postalCode: string | undefined;
  onChange: (patch: Partial<CustomerCreateInput>) => void;
}) {
  const selectedRegion = useMemo(
    () => PSGC_REGIONS.find((r) => r.name === region) ?? null,
    [region],
  );
  const provincesInRegion = useMemo(
    () => (region ? provincesForRegion(region) : []),
    [region],
  );
  const selectedProvince = useMemo(
    () => provincesInRegion.find((p) => p.name === province) ?? null,
    [provincesInRegion, province],
  );

  // Only NCR. Asking the data rather than hardcoding the name means a
  // future region without provinces needs no change here.
  const noProvinces = Boolean(region) && !regionHasProvinces(region!);

  const cityCandidates = useMemo(
    () => citiesFor(region, province),
    [region, province],
  );

  return (
    <Grid>
      <Field label="Address line 1" required className="sm:col-span-2">
        <Input
          value={address}
          onChange={(e) => onChange({ address: e.target.value })}
          placeholder="House / unit, street"
          required
        />
      </Field>
      <Field label="Address line 2" className="sm:col-span-2">
        <Input
          value={addressLine2 ?? ""}
          onChange={(e) => onChange({ addressLine2: e.target.value })}
          placeholder="Subdivision, building, floor (optional)"
        />
      </Field>

      <Field label="Region">
        <SearchInput<PsgcRegion>
          items={[...PSGC_REGIONS]}
          value={selectedRegion}
          onSelect={(r) =>
            onChange({
              region: r?.name ?? undefined,
              // Picking a different region invalidates everything
              // downstream so the cascade stays consistent.
              province: undefined,
              city: "",
              barangay: undefined,
            })
          }
          matches={(r, q) =>
            r.name.toLowerCase().includes(q) ||
            (r.longName ?? "").toLowerCase().includes(q)
          }
          getDisplayLabel={(r) => r.name}
          getItemKey={(r) => r.code}
          placeholder="Search region…"
          renderSuggestion={(r) => (
            <span className="flex items-center justify-between gap-2 min-w-0">
              <span className="truncate">{r.name}</span>
              <span className="text-[10px] text-fg-subtle truncate">
                {r.longName ?? ""}
              </span>
            </span>
          )}
        />
      </Field>

      <Field label="Province">
        {noProvinces ? (
          <Input
            value=""
            disabled
            placeholder="NCR has no provinces"
            className="opacity-60"
          />
        ) : (
          <SearchInput
            items={provincesInRegion}
            value={selectedProvince}
            onSelect={(p) =>
              onChange({
                province: p?.name ?? undefined,
                // Different province → city + barangay no longer valid.
                city: "",
                barangay: undefined,
              })
            }
            matches={(p, q) => p.name.toLowerCase().includes(q)}
            getDisplayLabel={(p) => p.name}
            getItemKey={(p) => p.code}
            placeholder={region ? "Search province…" : "Pick a region first"}
            disabled={!region}
            renderSuggestion={(p) => <span>{p.name}</span>}
          />
        )}
      </Field>

      <Field label="City / Municipality" required>
        <SuggestInput
          value={city}
          onChange={(v) =>
            onChange({
              city: v,
              // Changing the city invalidates the barangay choice.
              barangay: undefined,
            })
          }
          suggestions={cityCandidates.map((c) => ({
            key: c.code,
            label: c.name + (c.isCapital ? " · capital" : ""),
          }))}
          placeholder={
            province || noProvinces
              ? "Type or pick a city"
              : "Type or pick — narrow it with a region first"
          }
          required
        />
      </Field>

      <Field label="Barangay">
        <BarangayPicker
          region={region}
          province={province}
          city={city}
          value={barangay ?? ""}
          onChange={(v) => onChange({ barangay: v || undefined })}
        />
      </Field>

      <Field label="ZIP code">
        <Input
          value={postalCode ?? ""}
          onChange={(e) => onChange({ postalCode: e.target.value })}
          maxLength={20}
          placeholder="4-digit"
        />
      </Field>
    </Grid>
  );
}

// ─── Form helpers (kept local — not reused outside) ─────────────────

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
        {title}
      </div>
      {children}
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>
  );
}

function EnumSelect<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  /** Forwarded to the trigger so a `Field` label can name it. */
  id,
}: {
  value: T | undefined | null;
  onChange: (v: T | undefined) => void;
  options: Array<{ value: T; label: string }>;
  placeholder?: string;
  id?: string;
}) {
  return (
    <Select
      value={value ?? ""}
      onValueChange={(v) => onChange(v ? (v as T) : undefined)}
    >
      <SelectTrigger id={id}>
        <SelectValue placeholder={placeholder ?? "— select —"} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Helper for converting an existing Customer row into the form-state
 * shape expected by `CustomerProfileForm`. Used by EditCustomerDialog
 * to hydrate the editor from an already-saved record.
 */
export function customerToFormState(c: {
  firstName: string;
  middleName: string | null;
  lastName: string;
  suffix: string | null;
  dateOfBirth: string;
  gender: Gender | null;
  sex: Sex | null;
  civilStatus: CivilStatus | null;
  phone: string;
  secondaryPhone: string | null;
  email: string | null;
  address: string;
  addressLine2: string | null;
  barangay: string | null;
  city: string;
  province: string | null;
  region: string | null;
  postalCode: string | null;
  spouseName: string | null;
  spouseDateOfBirth: string | null;
  spouseContact: string | null;
  spouseOccupation: string | null;
  governmentIdType: CustomerCreateInput["governmentIdType"];
  governmentIdNumber: string;
  employmentStatus: CustomerCreateInput["employmentStatus"];
  employerName: string | null;
  jobTitle: string | null;
  position: string | null;
  hireDate: string | null;
  regularizationDate: string | null;
  monthlyIncome: string | number;
  yearsAtCurrentJob: string | number | null;
}): CustomerCreateInput {
  const stripTime = (iso: string | null) =>
    iso ? iso.slice(0, 10) : undefined;
  return {
    firstName: c.firstName,
    lastName: c.lastName,
    middleName: c.middleName ?? undefined,
    suffix: c.suffix ?? undefined,
    dateOfBirth: stripTime(c.dateOfBirth) ?? "",
    gender: c.gender ?? undefined,
    sex: c.sex ?? undefined,
    civilStatus: c.civilStatus ?? undefined,
    phone: c.phone,
    secondaryPhone: c.secondaryPhone ?? undefined,
    email: c.email ?? undefined,
    address: c.address,
    addressLine2: c.addressLine2 ?? undefined,
    barangay: c.barangay ?? undefined,
    city: c.city,
    province: c.province ?? undefined,
    region: c.region ?? undefined,
    postalCode: c.postalCode ?? undefined,
    spouseName: c.spouseName ?? undefined,
    spouseDateOfBirth: stripTime(c.spouseDateOfBirth),
    spouseContact: c.spouseContact ?? undefined,
    spouseOccupation: c.spouseOccupation ?? undefined,
    governmentIdType: c.governmentIdType,
    governmentIdNumber: c.governmentIdNumber,
    employmentStatus: c.employmentStatus,
    employerName: c.employerName ?? undefined,
    jobTitle: c.jobTitle ?? undefined,
    position: c.position ?? undefined,
    hireDate: stripTime(c.hireDate),
    regularizationDate: stripTime(c.regularizationDate),
    monthlyIncome: Number(c.monthlyIncome ?? 0),
    yearsAtCurrentJob:
      c.yearsAtCurrentJob != null ? Number(c.yearsAtCurrentJob) : undefined,
  };
}
