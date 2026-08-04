import {
  useCustomer,
  useSubmitSurvey,
  useSurveyQuestions,
} from "@loan/api-client";
import type {
  CreditTier,
  SurveyAnswer,
  SurveyQuestion,
} from "@loan/shared-types";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  SkeletonCard,
  useToast,
} from "@loan/ui";
import { Gauge } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

/**
 * Credit-scoring survey. Pulls the question catalog from the API, walks
 * the user through one screen of inputs, and on submit hands the answers
 * to the scoring engine. The result (score + tier + breakdown) is shown
 * inline before we kick back to the customer page.
 */
export function CreditSurveyPage() {
  const { id = "" } = useParams<{ id: string }>();
  const customer = useCustomer(id);
  const questions = useSurveyQuestions();
  const submit = useSubmitSurvey();
  const toast = useToast();
  const navigate = useNavigate();

  const [answers, setAnswers] = useState<Record<string, SurveyAnswer>>({});
  const [result, setResult] = useState<{
    score: number;
    tier: CreditTier;
    bucket?: "EXCELLENT" | "GOOD" | "FAIR" | "POOR";
  } | null>(null);

  const setAnswer = (qid: string, value: SurveyAnswer) =>
    setAnswers((a) => ({ ...a, [qid]: value }));

  const ready = useMemo(() => {
    if (!questions.data) return false;
    return questions.data.every((q) => answers[q.id] !== undefined);
  }, [answers, questions.data]);

  const onSubmit = async () => {
    try {
      const res = await submit.mutateAsync({ customerId: id, answers });
      const bucket = (
        res as { bucket?: "EXCELLENT" | "GOOD" | "FAIR" | "POOR" }
      ).bucket;
      setResult({ score: res.score, tier: res.tier, bucket });
      toast.success(`Score ${res.score} · ${bucket ?? `Tier ${res.tier}`}`);
    } catch (err) {
      toast.error((err as Error).message ?? "Submit failed");
    }
  };

  if (questions.isLoading || customer.isLoading) return <SkeletonCard />;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gauge className="h-4 w-4 text-info" />
          Credit-scoring survey · {customer.data?.firstName}{" "}
          {customer.data?.lastName}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-fg-muted">
          Answer all questions honestly. The score combines your responses with
          any prior loan history we have on file to produce a single credit
          grade between 300 and 850.
        </p>

        {result ? (
          <div className="rounded-md border border-default bg-surface-2 p-6 text-center space-y-2">
            <div className="text-xs uppercase tracking-wider text-fg-muted">
              Final score
            </div>
            <div className="text-5xl font-semibold tracking-tight">
              {result.score}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
              300 — 850 scale
            </div>
            <div className="flex items-center justify-center gap-2 pt-2">
              {result.bucket && (
                <span
                  className={
                    result.bucket === "EXCELLENT"
                      ? "text-success"
                      : result.bucket === "GOOD"
                        ? "text-info"
                        : result.bucket === "FAIR"
                          ? "text-warning"
                          : "text-danger"
                  }
                >
                  {result.bucket.charAt(0) +
                    result.bucket.slice(1).toLowerCase()}
                </span>
              )}
              <span className="text-fg-subtle text-xs">
                · Tier {result.tier}
              </span>
            </div>
            <div className="flex gap-2 justify-center pt-3">
              <Button
                variant="outline"
                onClick={() => navigate(`/customers/${id}`)}
              >
                Back to customer
              </Button>
              <Button
                onClick={() => {
                  setResult(null);
                  setAnswers({});
                }}
              >
                Re-take
              </Button>
            </div>
          </div>
        ) : (
          <>
            <ul className="space-y-4">
              {(questions.data ?? []).map((q) => (
                <li key={q.id}>
                  <QuestionView
                    question={q}
                    value={answers[q.id]}
                    onChange={(v) => setAnswer(q.id, v)}
                  />
                </li>
              ))}
            </ul>
            <div className="flex justify-end">
              <Button onClick={onSubmit} disabled={!ready || submit.isPending}>
                {submit.isPending ? "Scoring…" : "Compute score"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function QuestionView({
  question,
  value,
  onChange,
}: {
  question: SurveyQuestion;
  value: SurveyAnswer | undefined;
  onChange: (v: SurveyAnswer) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-sm font-medium">{question.label}</div>
      {question.help && (
        <div className="text-xs text-fg-subtle">{question.help}</div>
      )}

      {question.kind === "choice" && (
        <div className="flex flex-wrap gap-2">
          {question.options.map((o) => {
            const active = value === o.value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => onChange(o.value)}
                className={
                  "rounded-md border px-3 py-1.5 text-sm transition-colors " +
                  (active
                    ? "border-sky-400/50 bg-sky-500/15 text-info"
                    : "border-default bg-surface-2 hover:bg-hover")
                }
              >
                {o.label}
              </button>
            );
          })}
        </div>
      )}

      {question.kind === "number" && (
        <Input
          type="number"
          min={question.min}
          max={question.max}
          step={question.step ?? 1}
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      )}

      {question.kind === "boolean" && (
        <div className="flex gap-2">
          {[
            { v: true, label: "Yes" },
            { v: false, label: "No" },
          ].map((o) => {
            const active = value === o.v;
            return (
              <button
                key={String(o.v)}
                type="button"
                onClick={() => onChange(o.v)}
                className={
                  "rounded-md border px-4 py-1.5 text-sm transition-colors " +
                  (active
                    ? "border-sky-400/50 bg-sky-500/15 text-info"
                    : "border-default bg-surface-2 hover:bg-hover")
                }
              >
                {o.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
