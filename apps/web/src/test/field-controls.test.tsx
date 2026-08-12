import { DatePicker, Field, SearchInput } from "@loan/ui";
import { describe, expect, it } from "vitest";
import { PhoneInput } from "../components/PhoneInput";
import { SuggestInput } from "../components/PsgcFields";
import { render, screen } from "./render";

/**
 * `Field` hands its generated id to the control by cloning it onto the
 * child. A component that accepts the prop and never puts it on a DOM
 * node swallows it in silence — no error, no warning, and a field that
 * looks migrated while its label still names nothing. That is precisely
 * how the original defect survived in a dozen files.
 *
 * So every wrapper used as a `Field` child gets a case here. The
 * assertion is deliberately the same one a user's screen reader makes:
 * resolve the label, and check something focusable comes back.
 */
const FOCUSABLE = new Set(["INPUT", "SELECT", "TEXTAREA", "BUTTON"]);

describe("Field id delivery through wrapper components", () => {
  it("PhoneInput", () => {
    render(
      <Field label="Mobile number">
        <PhoneInput value="09171234567" onChange={() => {}} />
      </Field>,
    );
    expect(screen.getByLabelText("Mobile number").tagName).toBe("INPUT");
  });

  it("SuggestInput", () => {
    render(
      <Field label="City">
        <SuggestInput value="" onChange={() => {}} suggestions={[]} />
      </Field>,
    );
    expect(screen.getByLabelText("City").tagName).toBe("INPUT");
  });

  it("DatePicker", () => {
    render(
      <Field label="Entry date">
        <DatePicker value="2026-08-12" onChange={() => {}} />
      </Field>,
    );
    // The trigger button is the focusable element, so the id lands there
    // rather than on the popover or a wrapper.
    expect(screen.getByLabelText("Entry date").tagName).toBe("BUTTON");
  });

  it("SearchInput, whose own aria-label must not shadow the Field label", () => {
    render(
      <Field label="Borrower">
        <SearchInput<{ id: string; name: string }>
          items={[]}
          value={null}
          onSelect={() => {}}
          matches={() => true}
          getDisplayLabel={(i) => i.name}
          getItemKey={(i) => i.id}
          renderSuggestion={(i) => <span>{i.name}</span>}
          placeholder="Search customers…"
        />
      </Field>,
    );

    /*
     * The regression guarded here: SearchInput used to fall back to
     * `aria-label={placeholder}` unconditionally. aria-label OUTRANKS a
     * <label> element, so the field would have announced itself as
     * "Search customers…" no matter what the Field said.
     */
    const input = screen.getByLabelText("Borrower");
    expect(FOCUSABLE.has(input.tagName)).toBe(true);
    expect(input).not.toHaveAttribute("aria-label");
    expect(screen.queryByLabelText("Search customers…")).toBeNull();
  });
});
