import { groupByCategory } from "@loan/kyc";
import type { KycQuestion, KycQuestionType } from "@loan/shared-types";
import { Badge, Button, Input, useToast } from "@loan/ui";
import { ArrowDown, ArrowUp, Plus, Save, Trash2 } from "lucide-react";
import { useState } from "react";

/**
 * Build a product's KYC declaration questionnaire.
 *
 * Holds a local draft and saves explicitly, unlike the version that
 * used to live inside the product editor's form: this page edits ONLY
 * the questionnaire, so there's no surrounding Save to ride on, and
 * silently persisting each keystroke would make a mistyped question a
 * live change to what applicants are asked.
 *
 * Question ids are slugified from the label on add and then frozen —
 * application snapshots key answers by id, so renaming a question keeps
 * its identity while deleting and re-adding deliberately makes a new
 * one.
 */
export function KycQuestionnaireBuilder({
  questions,
  onSave,
  readOnly = false,
  saving = false,
}: {
  questions: KycQuestion[];
  onSave: (next: KycQuestion[]) => Promise<void>;
  readOnly?: boolean;
  saving?: boolean;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<KycQuestion[]>(questions);
  const [label, setLabel] = useState("");
  const [type, setType] = useState<KycQuestionType>("YES_NO");
  const [options, setOptions] = useState("");
  const [category, setCategory] = useState("");
  const [required, setRequired] = useState(true);

  const dirty = JSON.stringify(draft) !== JSON.stringify(questions);

  const addQuestion = () => {
    const trimmed = label.trim();
    if (!trimmed) return;
    const slugBase =
      trimmed
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 50) || "question";
    let id = slugBase;
    let n = 2;
    while (draft.some((q) => q.id === id)) id = `${slugBase}_${n++}`;

    const parsedOptions = options
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    if (type === "SELECT" && parsedOptions.length < 2) {
      // Was a bare return — the Add button just did nothing, which
      // reads as "the page is broken", not "you're missing options".
      toast.error("A Select question needs at least two options");
      return;
    }

    setDraft([
      ...draft,
      {
        id,
        label: trimmed,
        type,
        required,
        ...(category.trim() ? { category: category.trim() } : {}),
        ...(type === "SELECT" ? { options: parsedOptions } : {}),
      },
    ]);
    setLabel("");
    setOptions("");
    // `category` persists between adds — questions come in runs within
    // one group, and retyping "Property" seven times is what stops
    // people using categories at all.
  };

  const move = (index: number, dir: -1 | 1) => {
    const next = [...draft];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    setDraft(next);
  };

  const groups = groupByCategory(draft);

  return (
    <div className="space-y-3">
      {draft.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No questions. Applications for this product skip the declarations step
          entirely.
        </p>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <div key={group.category} className="space-y-1.5">
              {groups.length > 1 && (
                <div className="text-xs uppercase tracking-wider text-fg-subtle">
                  {group.category}
                </div>
              )}
              {group.items.map((q) => {
                // Index within the whole draft, not the group — moving a
                // question has to reorder the real list.
                const i = draft.indexOf(q);
                return (
                  <div
                    key={q.id}
                    className="flex items-center gap-2 rounded border border-default bg-surface-2 px-2 py-1.5 text-sm"
                  >
                    <span className="flex-1 min-w-0 truncate">
                      {q.label}
                      {q.type === "SELECT" && (
                        <span className="text-fg-subtle text-xs">
                          {" "}
                          ({(q.options ?? []).join(" / ")})
                        </span>
                      )}
                    </span>
                    <Badge variant="muted">{q.type}</Badge>
                    {q.required && <Badge variant="warning">Required</Badge>}
                    {!readOnly && (
                      <>
                        <button
                          type="button"
                          aria-label={`Move "${q.label}" up`}
                          onClick={() => move(i, -1)}
                          disabled={i === 0}
                          className="text-fg-subtle hover:text-fg disabled:opacity-30"
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Move "${q.label}" down`}
                          onClick={() => move(i, 1)}
                          disabled={i === draft.length - 1}
                          className="text-fg-subtle hover:text-fg disabled:opacity-30"
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove "${q.label}"`}
                          onClick={() =>
                            setDraft(draft.filter((x) => x.id !== q.id))
                          }
                          className="text-fg-subtle hover:text-danger"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {!readOnly && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-7 gap-2 items-end border-t border-default pt-3">
            <div className="md:col-span-2">
              <label className="text-xs text-fg-muted">Question</label>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. What is the source of funds?"
              />
            </div>
            <div>
              <label className="text-xs text-fg-muted">Type</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as KycQuestionType)}
                className="w-full field-chrome rounded-md px-2 py-2 text-sm"
              >
                <option value="YES_NO">Yes / No</option>
                <option value="TEXT">Text</option>
                <option value="NUMBER">Number</option>
                <option value="SELECT">Select</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-fg-muted">Category</label>
              <Input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="General"
              />
            </div>
            {type === "SELECT" && (
              <div className="md:col-span-2">
                <label className="text-xs text-fg-muted">
                  Options (comma-separated)
                </label>
                <Input
                  value={options}
                  onChange={(e) => setOptions(e.target.value)}
                  placeholder="Salary, Business, Remittance"
                />
              </div>
            )}
            <label className="flex h-9 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={required}
                onChange={(e) => setRequired(e.target.checked)}
              />
              Required
            </label>
            <Button type="button" variant="outline" onClick={addQuestion}>
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              onClick={() => void onSave(draft)}
              disabled={!dirty || saving}
            >
              <Save className="h-3.5 w-3.5" />
              {saving ? "Saving…" : "Save questionnaire"}
            </Button>
            {dirty && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setDraft(questions)}
                disabled={saving}
              >
                Discard changes
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
