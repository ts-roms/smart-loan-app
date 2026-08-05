import type {
  KycAnswers,
  KycDeclarations,
  KycQuestion,
} from "@loan/shared-types";
import { Badge, Button, useToast } from "@loan/ui";
import { ClipboardList, Pencil } from "lucide-react";
import { useState } from "react";

import { DeclarationsForm } from "./DeclarationsForm";

/**
 * Read + edit surface for an application's declaration snapshot — the
 * KYC-stage capture. Rendered on both the officer loan detail page and
 * the borrower's portal loan page; the caller supplies the save
 * mutation, so this component doesn't know which side it's on.
 *
 * Renders nothing when the loan has no snapshot (the product had no
 * questionnaire at apply time) — same self-hiding convention as the
 * ledger panel.
 *
 * `editable` is decided by the caller: permission (kyc.submit) on the
 * officer side, ownership on the portal side, and pre-decision status
 * on both — the server enforces all of it again.
 */
export function DeclarationsPanel({
  declarations,
  editable,
  onSave,
  saving = false,
}: {
  declarations: KycDeclarations | null | undefined;
  editable: boolean;
  onSave?: (answers: KycAnswers) => Promise<void>;
  saving?: boolean;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<KycAnswers>({});

  const items = declarations?.items ?? [];
  if (items.length === 0) return null;

  const unanswered = items.filter(
    (i) => i.required && (i.answer === null || i.answer === ""),
  ).length;

  const startEdit = () => {
    // Seed the draft from current answers so an edit is an amendment,
    // not a blank slate over answers that already exist.
    setDraft(Object.fromEntries(items.map((i) => [i.id, i.answer])));
    setEditing(true);
  };

  const save = async () => {
    if (!onSave) return;
    try {
      await onSave(draft);
      toast.success("Declarations saved");
      setEditing(false);
    } catch (err) {
      toast.error((err as Error).message ?? "Could not save declarations");
    }
  };

  // Snapshot items → live question shapes for the form. Options ride in
  // the snapshot precisely so this reconstruction stays faithful to
  // what was asked at apply time.
  const questions: KycQuestion[] = items.map((i) => ({
    id: i.id,
    label: i.label,
    type: i.type,
    options: i.options,
    required: i.required,
  }));

  return (
    <div className="border-t border-default pt-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wider text-fg-muted flex items-center gap-1">
          <ClipboardList className="h-3 w-3" />
          KYC declarations
        </div>
        <div className="flex items-center gap-2">
          {unanswered > 0 ? (
            <Badge variant="warning">
              {unanswered} required unanswered — blocks approval
            </Badge>
          ) : (
            <Badge variant="success">Complete</Badge>
          )}
          {editable && !editing && (
            <Button variant="outline" size="sm" onClick={startEdit}>
              <Pencil className="h-3 w-3" />
              {unanswered > 0 ? "Answer" : "Amend"}
            </Button>
          )}
        </div>
      </div>

      {editing ? (
        <div className="space-y-3">
          <DeclarationsForm
            questions={questions}
            answers={draft}
            onChange={setDraft}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save declarations"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing(false)}
              disabled={saving}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <dl className="space-y-1.5">
          {items.map((i) => (
            <div key={i.id} className="flex items-start justify-between gap-3">
              <dt className="text-sm text-fg-muted">
                {i.label}
                {i.required && <span className="text-danger"> *</span>}
              </dt>
              <dd className="text-sm text-right">
                {i.answer === null || i.answer === "" ? (
                  <span className="text-fg-subtle italic">Unanswered</span>
                ) : typeof i.answer === "boolean" ? (
                  i.answer ? (
                    "Yes"
                  ) : (
                    "No"
                  )
                ) : (
                  String(i.answer)
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
