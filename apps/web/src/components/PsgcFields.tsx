import {
  PSGC_REGIONS,
  citiesFor,
  findCity,
  loadBarangaysForCity,
  provincesForRegion,
  regionHasProvinces,
} from "@loan/shared-utils";
import { Input } from "@loan/ui";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Shared PSGC address pickers.
 *
 * Every form that asks where someone lives should offer the same
 * ~1,640 real cities rather than a text box — but each form has its
 * own layout, so these are three drop-in fields rather than one block.
 * `CustomerProfileForm` composes them into its Grid; the portal and
 * complete-profile forms use them individually.
 *
 * All three accept and return the stored NAME, not a code. That's what
 * `Customer.region/province/city` hold, and it's what keeps a value
 * typed before this existed from being silently dropped.
 */

/**
 * A text input with a typeahead over known values.
 *
 * Suggest, don't constrain. A value that isn't in PSGC still saves —
 * a legacy row, an unusual spelling, a barangay-level address someone
 * typed into the city box. Rejecting it would lose data that's
 * already there; suggesting normalises the spelling of everything
 * else.
 *
 * The panel only opens once something is typed, so a pre-filled field
 * doesn't cover the fields below it on focus.
 */
export function SuggestInput({
  value,
  onChange,
  suggestions,
  placeholder,
  required,
  disabled,
  /** Forwarded to the inner input so a `Field` label can name it. */
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  suggestions: ReadonlyArray<{ key: string; label: string }>;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  id?: string;
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
        id={id}
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
    </div>
  );
}

/** All 17 regions. */
export function RegionPicker({
  value,
  onChange,
  disabled,
  /** Forwarded to the inner input so a `Field` label can name it. */
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <SuggestInput
      value={value}
      onChange={onChange}
      suggestions={PSGC_REGIONS.map((r) => ({
        key: r.code,
        label: r.name,
      }))}
      placeholder="Region — e.g. NCR, Region VII"
      disabled={disabled}
      id={id}
    />
  );
}

/**
 * Provinces in the given region, or all 82 when no region is set.
 *
 * Not gated on picking a region first: plenty of people know their
 * province and would have to go look up which region it's in to get
 * past a disabled field.
 */
export function ProvincePicker({
  region,
  value,
  onChange,
  disabled,
  /** Forwarded to the inner input so a `Field` label can name it. */
  id,
}: {
  region?: string | null;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  id?: string;
}) {
  const noProvinces = Boolean(region) && !regionHasProvinces(region!);
  const options = useMemo(() => {
    const scoped = region ? provincesForRegion(region) : [];
    return scoped.length > 0
      ? scoped
      : [...PSGC_REGIONS].flatMap((r) => provincesForRegion(r.name));
  }, [region]);

  if (noProvinces) {
    return (
      <Input
        id={id}
        value=""
        disabled
        placeholder={`${region} has no provinces`}
        className="opacity-60"
      />
    );
  }

  return (
    <SuggestInput
      value={value}
      onChange={onChange}
      suggestions={options.map((p) => ({ key: p.code, label: p.name }))}
      placeholder="Province"
      disabled={disabled}
      id={id}
    />
  );
}

/**
 * Cities and municipalities, narrowed by whatever is known.
 *
 * Never empty — see `citiesFor`. The capital marker is a hint for
 * disambiguating repeated names, of which there are many.
 */
export function CityPicker({
  region,
  province,
  value,
  onChange,
  required,
  disabled,
  /** Forwarded to the inner input so a `Field` label can name it. */
  id,
}: {
  region?: string | null;
  province?: string | null;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  disabled?: boolean;
  id?: string;
}) {
  const options = useMemo(
    () => citiesFor(region, province),
    [region, province],
  );
  return (
    <SuggestInput
      value={value}
      onChange={onChange}
      suggestions={options.map((c) => ({
        key: c.code,
        label: c.name + (c.isCapital ? " · capital" : ""),
      }))}
      placeholder="City or municipality"
      required={required}
      disabled={disabled}
      id={id}
    />
  );
}

/**
 * Barangays for the chosen city, fetched on demand.
 *
 * The full set is 42,046 entries, so the region's chunk loads only
 * once a city is identified — see `loadBarangaysForCity`. Until then,
 * and for a city that isn't in PSGC, this is an ordinary text input:
 * suggestions are a convenience, never a gate.
 *
 * Identifying the city needs the region/province scope, because a bare
 * name like "San Isidro" matches a dozen municipalities. Without a
 * unique match there's no list to offer, and offering some other
 * town's barangays would be worse than offering none.
 */
export function BarangayPicker({
  region,
  province,
  city,
  value,
  onChange,
  disabled,
  /** Forwarded to the inner input so a `Field` label can name it. */
  id,
}: {
  region?: string | null;
  province?: string | null;
  city: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  id?: string;
}) {
  const resolved = useMemo(
    () => findCity(city, region, province),
    [city, region, province],
  );
  const [options, setOptions] = useState<string[]>([]);

  useEffect(() => {
    if (!resolved) {
      setOptions([]);
      return;
    }
    // Guarded against the city changing mid-flight: without this, a
    // slow chunk for the previous city could land after the new one
    // and offer the wrong list.
    let live = true;
    void loadBarangaysForCity(resolved).then((rows) => {
      if (live) setOptions(rows);
    });
    return () => {
      live = false;
    };
  }, [resolved]);

  return (
    <SuggestInput
      value={value}
      onChange={onChange}
      suggestions={options.map((name) => ({ key: name, label: name }))}
      placeholder={city ? "Barangay" : "Barangay — pick a city for suggestions"}
      disabled={disabled}
      id={id}
    />
  );
}
