import {
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@loan/ui";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "./render";

/**
 * The regression these guard is subtle: the label was always *visible*,
 * so the fields looked fine. What was missing is the association, and
 * `getByLabelText` is the cheapest way to state it — it resolves a
 * label to the control it names, and fails when the label names
 * nothing (or names a wrapper instead of the control).
 */
describe("Field", () => {
  it("associates its label with a plain input", () => {
    render(
      <Field label="Principal">
        <Input defaultValue="1000" />
      </Field>,
    );

    const control = screen.getByLabelText("Principal");
    expect(control.tagName).toBe("INPUT");
    expect(control).toHaveValue("1000");
  });

  it("gives the label a htmlFor matching the control id", () => {
    const { container } = render(
      <Field label="Principal">
        <Input />
      </Field>,
    );

    const label = container.querySelector("label");
    const input = container.querySelector("input");
    expect(label?.getAttribute("for")).toBeTruthy();
    expect(label?.getAttribute("for")).toBe(input?.id);
  });

  it("names a Radix select trigger through the render-prop form", () => {
    render(
      <Field label="Product">
        {(id) => (
          <Select defaultValue="personal">
            <SelectTrigger id={id}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="personal">Personal</SelectItem>
            </SelectContent>
          </Select>
        )}
      </Field>,
    );

    // The trigger is the button carrying the combobox role — that is
    // the element a screen reader lands on, so that is what has to
    // resolve from the label.
    const trigger = screen.getByLabelText("Product");
    expect(trigger).toHaveAttribute("role", "combobox");
  });

  it("keeps an id the caller set rather than overwriting it", () => {
    render(
      <Field label="Term">
        <Input id="term-months" />
      </Field>,
    );

    expect(screen.getByLabelText("Term")).toHaveAttribute("id", "term-months");
  });

  it("gives each instance a distinct id", () => {
    const { container } = render(
      <>
        <Field label="First">
          <Input />
        </Field>
        <Field label="Second">
          <Input />
        </Field>
      </>,
    );

    const ids = Array.from(container.querySelectorAll("input")).map(
      (i) => i.id,
    );
    expect(new Set(ids).size).toBe(2);
    expect(screen.getByLabelText("First")).not.toBe(
      screen.getByLabelText("Second"),
    );
  });

  it("renders the required marker and hint without breaking association", () => {
    const { container } = render(
      <Field label="Email" required hint="We only use this for statements.">
        <Input />
      </Field>,
    );

    /*
     * Matched loosely on purpose. The marker is `aria-hidden`, so the
     * name a screen reader computes is "Email" — but getByLabelText
     * reads the label's textContent rather than running the accessible
     * name algorithm, and textContent still contains the asterisk. The
     * association is what is under test here; the exact-string form is
     * covered by the non-required cases above.
     */
    expect(screen.getByLabelText(/^Email/).tagName).toBe("INPUT");
    expect(container.querySelector("label span")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(
      screen.getByText("We only use this for statements."),
    ).toBeInTheDocument();
  });

  it("passes className through to the wrapper so layout is caller-owned", () => {
    const { container } = render(
      <Field label="Notes" className="sm:col-span-2">
        <Input />
      </Field>,
    );

    const wrapper = container.firstElementChild;
    expect(wrapper).toHaveClass("space-y-1");
    expect(wrapper).toHaveClass("sm:col-span-2");
  });

  it("warns instead of silently failing when the id cannot be attached", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(
      <Field label="Range">
        <>
          <Input />
          <Input />
        </>
      </Field>,
    );

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[Field]"));
    warn.mockRestore();
  });
});
