import type {
  CivilStatus,
  CustomerCreateInput,
  Gender,
  Sex,
} from "@loan/shared-types";
import {
  PSGC_REGIONS,
  barangaysForCity,
  citiesForProvince,
  citiesForRegion,
  provincesForRegion,
  type PsgcRegion,
} from "@loan/shared-utils";
import {
  Button,
  DatePicker,
  Input,
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from "@loan/ui";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

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
    <form onSubmit={handleSubmit} className="space-y-5">
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
              max={new Date().toISOString().slice(0, 10)}
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
            <Field label="Spouse full name" required className="sm:col-span-2">
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
                max={new Date().toISOString().slice(0, 10)}
              />
            </Field>
            <Field label="Spouse contact">
              <Input
                value={form.spouseContact ?? ""}
                onChange={(e) => set("spouseContact", e.target.value)}
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
            <Input
              value={form.phone}
              onChange={(e) => set("phone", e.target.value)}
              placeholder="+63 9XX XXX XXXX"
              required
            />
          </Field>
          <Field label="Secondary phone">
            <Input
              value={form.secondaryPhone ?? ""}
              onChange={(e) => set("secondaryPhone", e.target.value)}
              placeholder="Optional"
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
                  max={new Date().toISOString().slice(0, 10)}
                />
              </Field>
              <Field label="Regularization date">
                <DatePicker
                  value={form.regularizationDate ?? ""}
                  onChange={(v) => set("regularizationDate", v)}
                  max={new Date().toISOString().slice(0, 10)}
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

      <div className="sticky bottom-0 bg-surface-2 pt-2 -mx-6 px-6 border-t border-default flex justify-end gap-2">
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
 * Cascading region → province picker. NCR has no provinces (cities sit
 * directly under the region), so the province row hides when NCR is
 * selected and the city + barangay fields stay free-text in all cases
 * (the full barangay list is too large to bundle).
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

  // NCR + BARMM regions sometimes have city-direct sub-units; for NCR
  // specifically the province slot is officially blank. We surface a
  // hint so the operator knows to skip it.
  const noProvinces = selectedRegion?.name === "NCR";

  // City suggestions cascade from province (or directly from region for
  // NCR which has no provinces). The list is bundled in PSGC_CITIES;
  // SuggestInput allows free-typing when the operator's city isn't in
  // the bundled subset.
  const cityCandidates = useMemo(() => {
    if (province) return citiesForProvince(province);
    if (noProvinces && region) return citiesForRegion(region);
    return [];
  }, [province, noProvinces, region]);

  // Barangay suggestions cascade from the typed city — looked up by
  // exact-name match against the bundled cities. If the city was typed
  // freely (not in the bundle), the lookup returns [] and the field
  // falls back to a plain typeahead-less input via the same component.
  const barangayCandidates = useMemo(
    () => (city ? barangaysForCity(city) : []),
    [city],
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
              : "e.g. Quezon City, Cebu City"
          }
          required
          emptyHint={
            (province || noProvinces) && cityCandidates.length === 0
              ? "No bundled cities for this area — type the name."
              : undefined
          }
        />
      </Field>

      <Field label="Barangay">
        <SuggestInput
          value={barangay ?? ""}
          onChange={(v) => onChange({ barangay: v || undefined })}
          suggestions={barangayCandidates.map((b) => ({
            key: b.code,
            label: b.name,
          }))}
          placeholder={city ? "Type or pick a barangay" : "Pick a city first"}
          emptyHint={
            city && barangayCandidates.length === 0
              ? "No bundled barangays for this city — type the name."
              : undefined
          }
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

function Field({
  label,
  children,
  className,
  required,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  required?: boolean;
}) {
  return (
    <div className={`space-y-1 ${className ?? ""}`}>
      <label className="text-xs text-fg-muted flex items-center gap-1">
        {label}
        {required && <span className="text-danger">*</span>}
      </label>
      {children}
    </div>
  );
}

/**
 * Free-text input with an inline floating suggestion list. Used by the
 * AddressBlock for City and Barangay, where:
 *   • the operator's value should pass through unchanged (so a city
 *     not in our bundled PSGC subset still saves correctly),
 *   • but a typeahead list helps autocomplete + normalise spelling
 *     when a bundled match is available.
 *
 * The dropdown only renders when the user has actively typed (i.e. it
 * doesn't open the moment the field is focused). That keeps the UI
 * quiet for empty / pre-filled inputs and prevents the suggestion
 * panel from covering downstream fields.
 */
function SuggestInput({
  value,
  onChange,
  suggestions,
  placeholder,
  required,
  disabled,
  emptyHint,
}: {
  value: string;
  onChange: (v: string) => void;
  suggestions: ReadonlyArray<{ key: string; label: string }>;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  /** Small caption when no suggestions are available for the current parent. */
  emptyHint?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const q = value.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return [] as typeof suggestions;
    return suggestions
      .filter((s) => s.label.toLowerCase().includes(q))
      .slice(0, 8);
  }, [q, suggestions]);

  // Close the dropdown on outside click. The panel itself is a child of
  // the same container so clicks on a suggestion don't trigger this.
  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", handle);
    return () => window.removeEventListener("mousedown", handle);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <Input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          if (value.trim().length > 0) setOpen(true);
        }}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
      />
      {open && matches.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-auto rounded-md border border-border bg-surface-2 shadow-lg">
          {matches.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => {
                onChange(m.label);
                setOpen(false);
              }}
              className="block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-3"
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
      {emptyHint && q.length === 0 && (
        <div className="mt-1 text-[10px] text-fg-subtle">{emptyHint}</div>
      )}
    </div>
  );
}

function EnumSelect<T extends string>({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: T | undefined | null;
  onChange: (v: T | undefined) => void;
  options: Array<{ value: T; label: string }>;
  placeholder?: string;
}) {
  return (
    <Select
      value={value ?? ""}
      onValueChange={(v) => onChange(v ? (v as T) : undefined)}
    >
      <SelectTrigger>
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
