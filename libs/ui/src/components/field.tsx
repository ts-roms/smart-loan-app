import {
  Fragment,
  cloneElement,
  isValidElement,
  useId,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "../lib/cn";

/**
 * Label + control pair for form rows.
 *
 * Nine feature files had each grown their own private `Field` with the
 * same body, and every one of them rendered a bare
 * `<label className="…">{label}</label>` with nothing tying it to the
 * control underneath. That label is decoration: a screen reader reaches
 * the input and announces an unnamed textbox, and clicking the text
 * does not focus the field. This component exists so that association
 * is written and tested once.
 *
 * ## How the control gets its name
 *
 * A generated `useId()` goes on `<label htmlFor>`, and the same id has
 * to land on the control. There are two ways to deliver it:
 *
 *   1. **Automatic.** When `children` is a single element, the id is
 *      cloned onto it. This covers the common case — `<Input />`,
 *      `<textarea />`, a native `<select>` — with nothing to remember
 *      at the call site.
 *
 *   2. **Render prop.** `children` may instead be a function receiving
 *      the id, for when the element that must carry it is nested:
 *
 *        <Field label="Product">
 *          {(id) => (
 *            <Select value={v} onValueChange={setV}>
 *              <SelectTrigger id={id}>…</SelectTrigger>
 *              …
 *            </Select>
 *          )}
 *        </Field>
 *
 * Radix `Select` REQUIRES form 2, and this is the sharp edge worth
 * knowing about: cloning an `id` onto `<Select>` fails silently. The
 * root renders no DOM node of its own, so the prop is accepted,
 * dropped, and nothing warns — the field looks migrated and is still
 * unlabelled. The id belongs on `SelectTrigger`, which is the button
 * that actually carries the `combobox` role. The same reasoning applies
 * to any wrapper component that does not forward `id` to a DOM
 * element.
 *
 * Fragments and arrays hit the same wall — there is no single element
 * to clone onto — so in development those get a console warning rather
 * than passing quietly.
 *
 * `htmlFor` + `id` is used rather than `aria-labelledby` on a wrapping
 * `<div>`. The latter reads like it should work and does not: it names
 * the *div*, which has no role, while the input inside keeps no
 * accessible name at all. It also defeats `getByLabelText`, which then
 * matches the wrapper instead of the control.
 */
export interface FieldProps {
  /** Visible label text. */
  label: ReactNode;
  /**
   * The control. A single element receives the generated id
   * automatically; pass a function to place the id yourself.
   */
  children: ReactNode | ((controlId: string) => ReactNode);
  /** Extra classes for the wrapper, so callers keep their own layout. */
  className?: string;
  /** Extra classes for the label element. */
  labelClassName?: string;
  /** Renders a required marker after the label text. */
  required?: boolean;
  /** Extra classes for the required marker. */
  requiredClassName?: string;
  /** Small helper text rendered under the control. */
  hint?: ReactNode;
  /**
   * Use a caller-supplied id instead of a generated one, for controls
   * that already have an id of their own.
   */
  htmlFor?: string;
}

export function Field({
  label,
  children,
  className,
  labelClassName,
  required,
  requiredClassName,
  hint,
  htmlFor,
}: FieldProps) {
  const generatedId = useId();
  // An id the caller already put on the control wins over the generated
  // one: pointing `htmlFor` at an id that exists beats replacing it and
  // breaking whatever else referenced it.
  const controlId = htmlFor ?? existingChildId(children) ?? generatedId;

  return (
    <div className={cn("space-y-1", className)}>
      <label
        htmlFor={controlId}
        className={cn("text-xs text-fg-muted", labelClassName)}
      >
        {label}
        {required && (
          <>
            {/*
             * The space is a separate text node on purpose. In a plain
             * inline label it supplies the gap before the marker; in a
             * flex label it is dropped as whitespace-only, leaving the
             * container's own `gap` to do the spacing. One marker
             * renders correctly under both.
             */}{" "}
            {/*
             * aria-hidden because the marker is decoration. Left
             * exposed it lands in the control's accessible name, which
             * a screen reader then reads as "Email star" — and every
             * `getByLabelText("Email")` in a test has to know to spell
             * the asterisk too. Requiredness belongs on the control
             * itself, via `required` / `aria-required`.
             */}
            <span
              aria-hidden="true"
              className={cn("text-danger", requiredClassName)}
            >
              *
            </span>
          </>
        )}
      </label>
      {renderControl(children, controlId)}
      {hint && <span className="text-[11px] text-fg-subtle block">{hint}</span>}
    </div>
  );
}

/** The id already present on a single-element child, if any. */
function existingChildId(
  children: ReactNode | ((controlId: string) => ReactNode),
): string | undefined {
  if (typeof children === "function" || !isValidElement(children)) {
    return undefined;
  }
  const { id } = (children as ReactElement<{ id?: string }>).props;
  return typeof id === "string" ? id : undefined;
}

function renderControl(
  children: ReactNode | ((controlId: string) => ReactNode),
  controlId: string,
): ReactNode {
  if (typeof children === "function") return children(controlId);

  if (isValidElement(children)) {
    const element = children as ReactElement<{ id?: string }>;
    if (element.props.id != null) return element;

    /*
     * A Fragment passes isValidElement but accepts no props beyond
     * `key`, so cloning an id onto it is silently dropped. Warn rather
     * than let the field look migrated while staying unlabelled.
     */
    if (element.type !== Fragment)
      return cloneElement(element, { id: controlId });
  }

  /*
   * Warned unconditionally rather than behind a NODE_ENV check: nothing
   * else in this library reads the environment, and it is meant to stay
   * that way. There is no cost to being noisy here — reaching this line
   * means the field is shipping with a label that names nothing, which
   * is worth hearing about wherever it happens.
   */
  if (children != null) {
    console.warn(
      "[Field] children is not a single id-accepting element, so the " +
        "generated id could not be attached and the label names " +
        "nothing. Use the render-prop form — {(id) => …} — and put the " +
        "id on the control.",
    );
  }
  return children;
}
