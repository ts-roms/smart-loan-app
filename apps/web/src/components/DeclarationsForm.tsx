import { groupByCategory } from "@loan/kyc";
import type { KycAnswers, KycQuestion } from "@loan/shared-types";
import { Input } from "@loan/ui";

/**
 * Renders a product's KYC declaration questions as form fields.
 *
 * App-level shared component (like FileUpload / SignaturePad) because
 * four surfaces render the same questionnaire: the officer wizard, the
 * portal apply page, and both loan-detail panels. Controlled — the
 * caller owns the answers map, because on the apply surfaces the
 * answers ride inside a larger submission payload.
 *
 * YES_NO renders as two radio buttons rather than a checkbox: an
 * unchecked checkbox can't distinguish "answered no" from "didn't
 * answer", and for declarations that difference is the whole point.
 */
export function DeclarationsForm({
  questions,
  answers,
  onChange,
  disabled = false,
}: {
  questions: KycQuestion[];
  answers: KycAnswers;
  onChange: (next: KycAnswers) => void;
  disabled?: boolean;
}) {
  if (questions.length === 0) return null;

  const set = (id: string, value: string | number | boolean | null) =>
    onChange({ ...answers, [id]: value });

  const groups = groupByCategory(questions);
  // A single "General" group means the author never used categories —
  // rendering one lone heading over every question would be noise.
  const showHeadings = groups.length > 1;

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group.category} className="space-y-3">
          {showHeadings && (
            <div className="text-xs uppercase tracking-wider text-fg-subtle border-b border-default pb-1">
              {group.category}
            </div>
          )}
          {group.items.map((q) => (
            <div key={q.id} className="space-y-1">
              <label className="block text-sm">
                {q.label}
                {q.required && <span className="text-danger"> *</span>}
              </label>
              {q.hint && <p className="text-xs text-fg-subtle">{q.hint}</p>}

              {q.type === "TEXT" && (
                <Input
                  value={(answers[q.id] as string) ?? ""}
                  onChange={(e) => set(q.id, e.target.value || null)}
                  disabled={disabled}
                  maxLength={1000}
                />
              )}

              {q.type === "NUMBER" && (
                <Input
                  type="number"
                  value={
                    answers[q.id] === null || answers[q.id] === undefined
                      ? ""
                      : String(answers[q.id])
                  }
                  onChange={(e) =>
                    set(
                      q.id,
                      e.target.value === "" ? null : Number(e.target.value),
                    )
                  }
                  disabled={disabled}
                />
              )}

              {q.type === "YES_NO" && (
                <div className="flex items-center gap-4 text-sm">
                  {[
                    { label: "Yes", value: true },
                    { label: "No", value: false },
                  ].map((opt) => (
                    <label
                      key={opt.label}
                      className="flex items-center gap-1.5"
                    >
                      <input
                        type="radio"
                        name={`decl-${q.id}`}
                        checked={answers[q.id] === opt.value}
                        onChange={() => set(q.id, opt.value)}
                        disabled={disabled}
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
              )}

              {q.type === "SELECT" && (
                <select
                  value={(answers[q.id] as string) ?? ""}
                  onChange={(e) => set(q.id, e.target.value || null)}
                  disabled={disabled}
                  className="w-full field-chrome rounded-md px-2 py-2 text-sm"
                >
                  <option value="">— Select —</option>
                  {(q.options ?? []).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
