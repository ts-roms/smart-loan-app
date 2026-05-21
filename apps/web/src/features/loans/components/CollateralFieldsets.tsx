/**
 * Vehicle / Property fieldsets — extracted from NewLoanDialog so they
 * can be reused by the new wizard page (and any future loan-edit flow).
 * No business logic here; just controlled inputs onto a typed value.
 */
import type { PropertyInput, VehicleInput } from "@loan/shared-types";
import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@loan/ui";
import type { ReactNode } from "react";

export function VehicleFieldset({
  value,
  onChange,
  productCode,
}: {
  value: VehicleInput;
  onChange: (next: VehicleInput) => void;
  productCode: string;
}) {
  return (
    <fieldset className="rounded-md border border-white/10 p-3 space-y-3">
      <legend className="px-1 text-xs uppercase tracking-wider text-white/45">
        {productCode === "MOTORCYCLE" ? "Motorcycle" : "Vehicle"} collateral
      </legend>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <CFLabel label="Make">
          <Input
            value={value.make}
            onChange={(e) => onChange({ ...value, make: e.target.value })}
            required
          />
        </CFLabel>
        <CFLabel label="Model">
          <Input
            value={value.model}
            onChange={(e) => onChange({ ...value, model: e.target.value })}
            required
          />
        </CFLabel>
        <CFLabel label="Year">
          <Input
            type="number"
            min={1900}
            max={2100}
            value={value.year}
            onChange={(e) =>
              onChange({ ...value, year: Number(e.target.value) })
            }
            required
          />
        </CFLabel>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <CFLabel label="Plate #">
          <Input
            value={value.plateNumber ?? ""}
            onChange={(e) =>
              onChange({ ...value, plateNumber: e.target.value })
            }
          />
        </CFLabel>
        <CFLabel label="Chassis #">
          <Input
            value={value.chassisNumber ?? ""}
            onChange={(e) =>
              onChange({ ...value, chassisNumber: e.target.value })
            }
          />
        </CFLabel>
        <CFLabel label="Appraised value (₱)">
          <Input
            type="number"
            min={1}
            value={value.appraisedValue || ""}
            onChange={(e) =>
              onChange({ ...value, appraisedValue: Number(e.target.value) })
            }
            required
          />
        </CFLabel>
      </div>
    </fieldset>
  );
}

export function PropertyFieldset({
  value,
  onChange,
}: {
  value: PropertyInput;
  onChange: (next: PropertyInput) => void;
}) {
  return (
    <fieldset className="rounded-md border border-white/10 p-3 space-y-3">
      <legend className="px-1 text-xs uppercase tracking-wider text-white/45">
        Property collateral
      </legend>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <CFLabel label="Property type">
          <Select
            value={value.propertyType}
            onValueChange={(v) => onChange({ ...value, propertyType: v })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="HOUSE_AND_LOT">House &amp; Lot</SelectItem>
              <SelectItem value="CONDO">Condominium</SelectItem>
              <SelectItem value="LOT_ONLY">Lot Only</SelectItem>
              <SelectItem value="COMMERCIAL">Commercial</SelectItem>
            </SelectContent>
          </Select>
        </CFLabel>
        <CFLabel label="Title #">
          <Input
            value={value.titleNumber ?? ""}
            onChange={(e) =>
              onChange({ ...value, titleNumber: e.target.value })
            }
          />
        </CFLabel>
        <CFLabel label="Tax dec #">
          <Input
            value={value.taxDecNumber ?? ""}
            onChange={(e) =>
              onChange({ ...value, taxDecNumber: e.target.value })
            }
          />
        </CFLabel>
      </div>
      <CFLabel label="Address">
        <Input
          value={value.address}
          onChange={(e) => onChange({ ...value, address: e.target.value })}
          required
        />
      </CFLabel>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <CFLabel label="City">
          <Input
            value={value.city}
            onChange={(e) => onChange({ ...value, city: e.target.value })}
            required
          />
        </CFLabel>
        <CFLabel label="Area (sqm)">
          <Input
            type="number"
            min={0}
            step={0.01}
            value={value.areaSqm ?? ""}
            onChange={(e) =>
              onChange({
                ...value,
                areaSqm: e.target.value ? Number(e.target.value) : undefined,
              })
            }
          />
        </CFLabel>
        <CFLabel label="Appraised value (₱)">
          <Input
            type="number"
            min={1}
            value={value.appraisedValue || ""}
            onChange={(e) =>
              onChange({ ...value, appraisedValue: Number(e.target.value) })
            }
            required
          />
        </CFLabel>
      </div>
    </fieldset>
  );
}

/** Default factory functions — used by both the wizard and the legacy dialog. */
export function defaultVehicle(): VehicleInput {
  return {
    kind: "CAR",
    make: "",
    model: "",
    year: new Date().getFullYear(),
    appraisedValue: 0,
  };
}

export function defaultProperty(): PropertyInput {
  return {
    propertyType: "HOUSE_AND_LOT",
    address: "",
    city: "",
    appraisedValue: 0,
  };
}

function CFLabel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-white/55">{label}</label>
      {children}
    </div>
  );
}
