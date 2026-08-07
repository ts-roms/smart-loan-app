import {
  useCreateSurveyFactor,
  useCreateSurveyQuestion,
  useDeleteSurveyFactor,
  useDeleteSurveyQuestion,
  useLoanProducts,
  useReorderSurveyQuestions,
  useScoringCatalog,
  useUpdateLoanProduct,
  useUpdateSurveyFactor,
  useUpdateSurveyQuestion,
  type CatalogFactorRow,
  type CatalogQuestion,
  type SurveyQuestionKind,
} from "@loan/api-client";
import type { KycQuestion, LoanProduct } from "@loan/shared-types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonCard,
  useConfirm,
  useToast,
} from "@loan/ui";
import {
  ArrowDown,
  ArrowUp,
  ClipboardList,
  Gauge,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";

import { usePermission } from "../../../hooks/use-permission";
import { KycQuestionnaireBuilder } from "../components/KycQuestionnaireBuilder";

/**
 * Questionnaires — one place for every set of questions the app asks.
 *
 * Two of them, deliberately on one page rather than two:
 *
 *   • KYC declarations, per loan product. Compliance answers; required
 *     ones gate approval. Previously buried at the bottom of the
 *     product editor, which is where nobody looked for them.
 *   • The credit survey, one catalog for the tenant. Scoring answers;
 *     they move a borrower's 300–850 score.
 *
 * Same page because "what do we ask an applicant" is one question an
 * admin has, even though the two sets have different consequences —
 * and seeing them together is what stops the same thing being asked
 * twice in both.
 */
export function QuestionnairesPage() {
  const [tab, setTab] = useState<"kyc" | "survey">("kyc");

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <TabButton
          active={tab === "kyc"}
          onClick={() => setTab("kyc")}
          icon={<ClipboardList className="h-3.5 w-3.5" />}
          label="KYC declarations"
        />
        <TabButton
          active={tab === "survey"}
          onClick={() => setTab("survey")}
          icon={<Gauge className="h-3.5 w-3.5" />}
          label="Credit survey"
        />
      </div>
      {tab === "kyc" ? <KycSection /> : <SurveySection />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// KYC declarations — per product
// ═══════════════════════════════════════════════════════════════════

function KycSection() {
  const products = useLoanProducts();
  const update = useUpdateLoanProduct();
  const toast = useToast();
  const canEdit = usePermission("products.write");
  const [selected, setSelected] = useState<string>("");

  const list = products.data ?? [];
  const product: LoanProduct | undefined =
    list.find((p) => p.code === selected) ?? list[0];

  const save = async (questions: KycQuestion[]) => {
    if (!product) return;
    try {
      // Only the questionnaire goes in the patch — the rest of the
      // product is untouched, so this page can't accidentally rewrite
      // pricing while someone edits a question.
      await update.mutateAsync({
        code: product.code,
        kycQuestions: questions,
      });
      toast.success(`${product.name} questionnaire saved`);
    } catch (err) {
      toast.error((err as Error).message ?? "Could not save");
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4" />
          KYC declarations
        </CardTitle>
        <Select value={product?.code ?? ""} onValueChange={setSelected}>
          <SelectTrigger className="w-56" aria-label="Product">
            <SelectValue placeholder="Select a product" />
          </SelectTrigger>
          <SelectContent>
            {list.map((p) => (
              <SelectItem key={p.code} value={p.code}>
                {p.name} · {(p.kycQuestions ?? []).length}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-fg-muted">
          Asked when someone applies for this product, and answerable again at
          the KYC stage. Required answers block approval. Each product has its
          own set — housing asks about the property, salary about employment.
        </p>
        {products.isLoading ? (
          <SkeletonCard />
        ) : !product ? (
          <p className="text-sm text-fg-muted">No products yet.</p>
        ) : (
          <KycQuestionnaireBuilder
            key={product.code}
            questions={product.kycQuestions ?? []}
            readOnly={!canEdit}
            saving={update.isPending}
            onSave={save}
          />
        )}
      </CardContent>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Credit survey — one catalog for the tenant
// ═══════════════════════════════════════════════════════════════════

function SurveySection() {
  const catalog = useScoringCatalog();
  const canEdit = usePermission("admin.scoring_catalog");

  const data = catalog.data;
  const factors = data?.factors ?? [];
  const activeFactors = factors.filter((f) => f.active);
  const totalWeight = activeFactors.reduce((s, f) => s + f.weight, 0);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gauge className="h-4 w-4" />
            Credit survey
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-fg-muted">
            The questions behind a borrower&apos;s 300–850 score. Factors carry
            a relative <strong>weight</strong>, not points — the points column
            is derived, and always sums to{" "}
            <strong>{data?.totalPoints ?? 150}</strong>. Adding a factor takes
            points from the others rather than growing the scale, so a 720 means
            the same thing before and after an edit and your decision rules keep
            their thresholds.
          </p>
          <p className="text-xs text-fg-subtle">
            Scores already computed keep the breakdown they were computed with —
            editing here never re-tiers an existing borrower. They pick up the
            new catalog the next time their survey is run.
          </p>
          {catalog.isLoading ? (
            <SkeletonCard />
          ) : (
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <Badge variant="muted">
                {activeFactors.length} active factors
              </Badge>
              <Badge variant="muted">
                {factors.reduce((s, f) => s + f.questions.length, 0)} questions
              </Badge>
              <span className="text-fg-subtle">
                total weight {totalWeight} → {data?.totalPoints ?? 150} points
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {catalog.isLoading ? (
        <SkeletonCard />
      ) : (
        factors.map((f) => (
          <FactorCard key={f.id} factor={f} canEdit={canEdit} />
        ))
      )}

      {canEdit && <AddFactorCard />}
    </div>
  );
}

function FactorCard({
  factor,
  canEdit,
}: {
  factor: CatalogFactorRow;
  canEdit: boolean;
}) {
  const update = useUpdateSurveyFactor();
  const remove = useDeleteSurveyFactor();
  const reorder = useReorderSurveyQuestions();
  const toast = useToast();
  const confirm = useConfirm();

  // Order is what the borrower sees. The endpoint sets order = array
  // index, so sending just this factor's ids renumbers them 0..n-1
  // within the factor without touching any other factor's questions.
  const moveQuestion = async (index: number, dir: -1 | 1) => {
    const ids = factor.questions.map((q) => q.id);
    const target = index + dir;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    try {
      await reorder.mutateAsync(ids);
    } catch (err) {
      toast.error((err as Error).message ?? "Could not reorder");
    }
  };
  const [weight, setWeight] = useState(String(factor.weight));
  const [label, setLabel] = useState(factor.label);

  const saveLabel = async () => {
    const trimmed = label.trim();
    if (!trimmed || trimmed === factor.label) {
      setLabel(factor.label);
      return;
    }
    try {
      await update.mutateAsync({ id: factor.id, patch: { label: trimmed } });
      toast.success("Factor renamed");
    } catch (err) {
      toast.error((err as Error).message ?? "Could not save");
      setLabel(factor.label);
    }
  };

  const toggleActive = async () => {
    try {
      await update.mutateAsync({
        id: factor.id,
        patch: { active: !factor.active },
      });
      toast.success(
        factor.active
          ? `${factor.label} deactivated — its points went to the others`
          : `${factor.label} reactivated — points redistributed`,
      );
    } catch (err) {
      toast.error((err as Error).message ?? "Could not save");
    }
  };

  const saveWeight = async () => {
    const value = Number(weight);
    if (!Number.isFinite(value) || value <= 0) {
      setWeight(String(factor.weight));
      return;
    }
    if (value === factor.weight) return;
    try {
      await update.mutateAsync({ id: factor.id, patch: { weight: value } });
      toast.success(`${factor.label} reweighted — points redistributed`);
    } catch (err) {
      toast.error((err as Error).message ?? "Could not save");
      setWeight(String(factor.weight));
    }
  };

  const onDelete = async () => {
    const ok = await confirm({
      title: `Delete factor "${factor.label}"?`,
      message:
        "Its points are redistributed across the remaining factors. Scores already computed keep their existing breakdown.",
      confirmLabel: "Delete factor",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(factor.id);
      toast.success(`Deleted ${factor.label}`);
    } catch (err) {
      // 409 when questions still hang off it — the message names the count.
      toast.error((err as Error).message ?? "Could not delete");
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle className="text-sm flex items-center gap-2 min-w-0">
          {canEdit ? (
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onBlur={saveLabel}
              aria-label={`${factor.label} name`}
              className="h-8 w-56 font-semibold"
            />
          ) : (
            factor.label
          )}
          {/* The key is deliberately not editable — stored score
              breakdowns reference it, so a rename orphans history. */}
          <span className="font-mono text-xs text-fg-subtle">{factor.key}</span>
          {factor.computed && (
            <Badge variant="muted" title="Derived from loan history">
              computed
            </Badge>
          )}
          {!factor.active && <Badge variant="warning">inactive</Badge>}
        </CardTitle>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs">
            weight
            <Input
              type="number"
              min={0.01}
              step={1}
              className="w-20 h-8"
              value={weight}
              disabled={!canEdit}
              onChange={(e) => setWeight(e.target.value)}
              onBlur={saveWeight}
              aria-label={`${factor.label} weight`}
            />
          </label>
          <Badge variant="success">{factor.maxPoints ?? 0} pts</Badge>
          {canEdit && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void toggleActive()}
            >
              {factor.active ? "Deactivate" : "Activate"}
            </Button>
          )}
          {canEdit && (
            <button
              type="button"
              aria-label={`Delete ${factor.label}`}
              onClick={onDelete}
              className="text-fg-subtle hover:text-danger"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {factor.computed ? (
          <p className="text-xs text-fg-subtle">
            Scored from loan history (on-time rate, defaults) — no survey
            question to configure.
          </p>
        ) : factor.questions.length === 0 ? (
          <p className="text-xs text-fg-muted">
            No questions — this factor scores nothing until one is added.
          </p>
        ) : (
          <ul className="space-y-1">
            {factor.questions.map((q, i) => (
              <QuestionRow
                key={q.id}
                question={q}
                canEdit={canEdit}
                onMove={(dir) => void moveQuestion(i, dir)}
                first={i === 0}
                last={i === factor.questions.length - 1}
              />
            ))}
          </ul>
        )}
        {canEdit && !factor.computed && <AddQuestionRow factorId={factor.id} />}
      </CardContent>
    </Card>
  );
}

/**
 * Config is entered as one compact "spec" string per kind rather than a
 * nested form:
 *
 *   CHOICE   Owned=1, Mortgaged=0.7, Renting=0.4
 *   NUMBER   0, 200000        (append ",inv" so higher answers score lower)
 *   BOOLEAN  1                (the weight when the answer is Yes)
 *
 * Weights are the share of the FACTOR's points an answer earns, so they
 * have to be visible and per-option — a nested builder would hide the
 * one number that decides what an answer is worth. The parse and the
 * render below are inverses, so an existing question round-trips back
 * into the same text it was created from.
 */
function parseSpec(
  kind: SurveyQuestionKind,
  spec: string,
): { config: unknown } | { error: string } {
  if (kind === "CHOICE") {
    const parts = spec
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const options: { label: string; value: string; weight: number }[] = [];
    const seen = new Map<string, number>();
    for (const part of parts) {
      const [lbl, w] = part.split("=");
      const label = (lbl ?? "").trim();
      if (!label) continue;
      // A missing or malformed weight is an error, not a silent zero —
      // "Owned, Renting=0.4" scoring Owned as worthless is exactly the
      // mistake nobody notices until borrowers complain.
      if (w === undefined) {
        return { error: `"${label}" has no weight — write ${label}=1` };
      }
      const weight = Number(w);
      if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
        return { error: `"${label}" needs a weight between 0 and 1` };
      }
      // Values derive from labels; labels differing only in punctuation
      // would collide, making the later option unselectable. Suffix.
      const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_") || "option";
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      options.push({
        label,
        value: n === 0 ? base : `${base}_${n + 1}`,
        weight,
      });
    }
    if (options.length < 2) {
      return { error: "Give at least two options, e.g. Owned=1, Renting=0.4" };
    }
    return { config: { options } };
  }
  if (kind === "NUMBER") {
    const [min, max, inv] = spec.split(",").map((part) => part.trim());
    const lo = Number(min);
    const hi = Number(max);
    if (!min || !max || !Number.isFinite(lo) || !Number.isFinite(hi)) {
      return { error: "Give min and max, e.g. 0, 200000 (add ,inv to invert)" };
    }
    if (hi <= lo) return { error: "max must exceed min" };
    return {
      config: {
        min: lo,
        max: hi,
        inverted: inv?.toLowerCase().startsWith("inv") ?? false,
      },
    };
  }
  const weight = Number(spec);
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
    return { error: "Give a weight between 0 and 1 for a Yes answer" };
  }
  return { config: { weightWhenTrue: weight } };
}

/** A stored config value is `unknown` — render it only if it's a number. */
function num(value: unknown, fallback: number): string {
  return String(typeof value === "number" ? value : fallback);
}

/** Stored config to spec string, so an edit starts from what is saved. */
function specFromConfig(kind: SurveyQuestionKind, config: unknown): string {
  const cfg = (config ?? {}) as Record<string, unknown>;
  if (kind === "CHOICE") {
    const options = Array.isArray(cfg.options) ? cfg.options : [];
    return options
      .map((o) => {
        const opt = o as { label?: string; weight?: number };
        return (opt.label ?? "") + "=" + num(opt.weight, 0);
      })
      .join(", ");
  }
  if (kind === "NUMBER") {
    const base = num(cfg.min, 0) + ", " + num(cfg.max, 0);
    return cfg.inverted === true ? base + ", inv" : base;
  }
  return num(cfg.weightWhenTrue, 1);
}

function specPlaceholder(kind: SurveyQuestionKind): string {
  return kind === "CHOICE"
    ? "Owned=1, Mortgaged=0.7, Renting=0.4"
    : kind === "NUMBER"
      ? "0, 200000  (append ,inv so higher scores lower)"
      : "1  (weight when Yes)";
}

/** Slug for a new row. Generated once, then frozen — keys are immutable. */
function slugify(label: string, fallback: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 50) || fallback
  );
}

/**
 * One question: a compact summary that expands into the same fields the
 * add row uses. Edited in place rather than on its own screen — a
 * weight only means something next to its siblings'.
 */
function QuestionRow({
  question,
  canEdit,
  onMove,
  first,
  last,
}: {
  question: CatalogQuestion;
  canEdit: boolean;
  onMove: (dir: -1 | 1) => void;
  first: boolean;
  last: boolean;
}) {
  const update = useUpdateSurveyQuestion();
  const remove = useDeleteSurveyQuestion();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);

  const [label, setLabel] = useState(question.label);
  const [category, setCategory] = useState(question.category ?? "");
  const [kind, setKind] = useState<SurveyQuestionKind>(question.kind);
  const [spec, setSpec] = useState(() =>
    specFromConfig(question.kind, question.config),
  );

  const open = () => {
    // Reset from the server row on every open, so a cancelled edit
    // doesn't leave stale text behind for the next one.
    setLabel(question.label);
    setCategory(question.category ?? "");
    setKind(question.kind);
    setSpec(specFromConfig(question.kind, question.config));
    setEditing(true);
  };

  const save = async () => {
    const trimmed = label.trim();
    if (!trimmed) {
      toast.error("A question needs a label");
      return;
    }
    const parsed = parseSpec(kind, spec);
    if ("error" in parsed) {
      toast.error(parsed.error);
      return;
    }
    try {
      await update.mutateAsync({
        id: question.id,
        patch: {
          label: trimmed,
          category: category.trim() || null,
          kind,
          config: parsed.config,
        },
      });
      toast.success("Question saved");
      setEditing(false);
    } catch (err) {
      toast.error((err as Error).message ?? "Could not save");
    }
  };

  const toggleActive = async () => {
    try {
      await update.mutateAsync({
        id: question.id,
        patch: { active: !question.active },
      });
    } catch (err) {
      toast.error((err as Error).message ?? "Could not save");
    }
  };

  const onDelete = async () => {
    const ok = await confirm({
      title: 'Delete "' + question.label + '"?',
      message:
        "Answers already recorded keep their stored value; the question simply stops being asked. Deactivate instead if you might bring it back.",
      confirmLabel: "Delete question",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(question.id);
      toast.success("Question deleted");
    } catch (err) {
      toast.error((err as Error).message ?? "Could not delete");
    }
  };

  if (editing) {
    return (
      <li className="rounded border border-brand bg-surface-2 p-2 space-y-2">
        <QuestionFields
          label={label}
          setLabel={setLabel}
          kind={kind}
          setKind={setKind}
          category={category}
          setCategory={setCategory}
          spec={spec}
          setSpec={setSpec}
        />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => void save()}
            disabled={update.isPending}
          >
            Save
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setEditing(false)}
          >
            <X className="h-3.5 w-3.5" />
            Cancel
          </Button>
          <span className="font-mono text-xs text-fg-subtle">
            {question.key}
          </span>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-center gap-2 rounded border border-default bg-surface-2 px-2 py-1.5 text-sm">
      <span className="flex-1 min-w-0 truncate">{question.label}</span>
      {question.category && <Badge variant="muted">{question.category}</Badge>}
      <Badge variant="muted">{question.kind}</Badge>
      {!question.active && <Badge variant="warning">inactive</Badge>}
      {canEdit && (
        <>
          <button
            type="button"
            aria-label={'Move "' + question.label + '" up'}
            onClick={() => onMove(-1)}
            disabled={first}
            className="text-fg-subtle hover:text-fg disabled:opacity-30"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label={'Move "' + question.label + '" down'}
            onClick={() => onMove(1)}
            disabled={last}
            className="text-fg-subtle hover:text-fg disabled:opacity-30"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
          <Button type="button" size="sm" variant="ghost" onClick={open}>
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void toggleActive()}
          >
            {question.active ? "Deactivate" : "Activate"}
          </Button>
          <button
            type="button"
            aria-label={'Delete question "' + question.label + '"'}
            onClick={() => void onDelete()}
            className="text-fg-subtle hover:text-danger"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </li>
  );
}

/** The four fields shared by the add row and the edit form. */
function QuestionFields({
  label,
  setLabel,
  kind,
  setKind,
  category,
  setCategory,
  spec,
  setSpec,
}: {
  label: string;
  setLabel: (v: string) => void;
  kind: SurveyQuestionKind;
  setKind: (v: SurveyQuestionKind) => void;
  category: string;
  setCategory: (v: string) => void;
  spec: string;
  setSpec: (v: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
      <div className="md:col-span-2">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Question"
          aria-label="Question label"
        />
      </div>
      <select
        value={kind}
        onChange={(e) => setKind(e.target.value as SurveyQuestionKind)}
        className="field-chrome rounded-md px-2 py-2 text-sm"
        aria-label="Question kind"
      >
        <option value="CHOICE">Choice</option>
        <option value="NUMBER">Number</option>
        <option value="BOOLEAN">Yes / No</option>
      </select>
      <Input
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        placeholder="Category"
        aria-label="Question category"
      />
      <Input
        value={spec}
        onChange={(e) => setSpec(e.target.value)}
        placeholder={specPlaceholder(kind)}
        aria-label="Answers and weights"
      />
    </div>
  );
}

/** Add a question to one factor. */
function AddQuestionRow({ factorId }: { factorId: string }) {
  const create = useCreateSurveyQuestion();
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<SurveyQuestionKind>("CHOICE");
  const [category, setCategory] = useState("");
  const [spec, setSpec] = useState("");

  const add = async () => {
    const trimmed = label.trim();
    if (!trimmed) return;
    const parsed = parseSpec(kind, spec);
    if ("error" in parsed) {
      toast.error(parsed.error);
      return;
    }
    try {
      await create.mutateAsync({
        key: slugify(trimmed, "question"),
        kind,
        label: trimmed,
        category: category.trim() || null,
        factorId,
        config: parsed.config,
      });
      toast.success("Question added");
      setLabel("");
      setSpec("");
      // Category deliberately persists — questions arrive a group at a time.
    } catch (err) {
      toast.error((err as Error).message ?? "Could not add");
    }
  };

  return (
    <div className="space-y-2 pt-1">
      <QuestionFields
        label={label}
        setLabel={setLabel}
        kind={kind}
        setKind={setKind}
        category={category}
        setCategory={setCategory}
        spec={spec}
        setSpec={setSpec}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void add()}
        disabled={create.isPending}
      >
        <Plus className="h-3.5 w-3.5" />
        Add question
      </Button>
    </div>
  );
}

function AddFactorCard() {
  const create = useCreateSurveyFactor();
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [weight, setWeight] = useState("10");

  const add = async () => {
    const trimmed = label.trim();
    if (!trimmed) return;
    // Refuse rather than repair: `Number(x) || 10` silently turned a
    // typo — or a deliberate "0" — into weight 10.
    const parsedWeight = Number(weight);
    if (!Number.isFinite(parsedWeight) || parsedWeight <= 0) {
      toast.error("Weight must be a positive number");
      return;
    }
    try {
      await create.mutateAsync({
        key: slugify(trimmed, "factor"),
        label: trimmed,
        weight: parsedWeight,
      });
      toast.success(`Added ${trimmed} — points redistributed`);
      setLabel("");
    } catch (err) {
      toast.error((err as Error).message ?? "Could not add");
    }
  };

  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[200px]">
            <label className="text-xs text-fg-muted">New factor</label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Utility payment history"
            />
          </div>
          <label className="text-xs text-fg-muted">
            Weight
            <Input
              type="number"
              min={0.01}
              className="w-24"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
            />
          </label>
          <Button
            type="button"
            variant="outline"
            onClick={add}
            disabled={create.isPending}
          >
            <Plus className="h-3.5 w-3.5" />
            Add factor
          </Button>
        </div>
        <p className="text-xs text-fg-subtle mt-2">
          Existing factors give up points to make room — the 300–850 scale does
          not move.
        </p>
      </CardContent>
    </Card>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm ${
        active
          ? "border-brand bg-brand/10 text-fg"
          : "border-default text-fg-muted hover:bg-hover"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
