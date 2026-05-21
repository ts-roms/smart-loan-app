import { useKycForCustomer } from "@loan/api-client";
import type { LoanApplication } from "@loan/shared-types";
import { Badge, Button, useToast } from "@loan/ui";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ScanFace,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";

import { compareFaces } from "../../../lib/face-match";
import { useRecordSelfieMatch } from "../hooks";

export interface FaceMatchPanelProps {
  loan: LoanApplication;
}

/**
 * Face-match (selfie ↔ ID) widget shown on the loan detail page. The
 * compare runs entirely in the browser via face-api.js — no pixel data
 * crosses our backend. Only the resulting score + model identifier are
 * persisted via POST /loans/:id/selfie-match.
 *
 * Surfaces:
 *   - Hidden when there's no selfie or no VERIFIED ID_FRONT to match
 *     against. There's nothing to compare.
 *   - When a prior score exists on the loan, renders that immediately
 *     with a "re-run" affordance.
 *   - When no prior score, shows "Run face match" — clicking lazy-loads
 *     ~6 MB of model weights, computes the score, and posts it.
 *
 * Errors (no face detected, model fetch failed, etc.) render as a
 * non-blocking warning row; the loan continues to function normally.
 */
export function FaceMatchPanel({ loan }: FaceMatchPanelProps) {
  const kyc = useKycForCustomer(loan.customerId);
  const record = useRecordSelfieMatch(loan.id);
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Latest VERIFIED ID_FRONT submission is the canonical "ID photo".
  // Submissions arrive newest-first from the API, so the first match
  // wins.
  const idDocUrl = useMemo(() => {
    const submissions = kyc.data ?? [];
    const idFront = submissions.find(
      (s) => s.documentType === "ID_FRONT" && s.status === "VERIFIED",
    );
    return idFront?.documentUrl ?? null;
  }, [kyc.data]);

  // Hide the panel entirely when there's nothing to match. The loan
  // detail page already shows the selfie + KYC checklist separately,
  // so the absence isn't surprising.
  if (!loan.applicationSelfieUrl || !idDocUrl) return null;

  const hasScore = loan.selfieMatchScore != null;

  const runMatch = async () => {
    if (!loan.applicationSelfieUrl || !idDocUrl) return;
    setRunning(true);
    setError(null);
    try {
      const result = await compareFaces(loan.applicationSelfieUrl, idDocUrl);
      await record.mutateAsync(result);
      toast.success(
        result.passed
          ? `Face match passed · similarity ${(result.score * 100).toFixed(1)}%`
          : `Face match failed · similarity ${(result.score * 100).toFixed(1)}%`,
      );
    } catch (err) {
      const msg = (err as Error).message ?? "Face match failed";
      setError(msg);
      toast.error(msg);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="rounded-md border border-white/10 bg-white/[0.03] p-3 space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 text-sm">
          <ScanFace className="h-4 w-4 text-sky-300" />
          <span className="font-medium">Face match</span>
          <span className="text-[10px] uppercase tracking-wider text-white/45">
            · selfie ↔ ID · client-local
          </span>
        </div>
        {hasScore ? (
          <ResultBadge
            passed={loan.selfieMatchPassed ?? false}
            score={loan.selfieMatchScore ?? 0}
          />
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={runMatch}
            disabled={running}
          >
            {running ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Running…
              </>
            ) : (
              <>
                <ScanFace className="h-3 w-3" />
                Run face match
              </>
            )}
          </Button>
        )}
      </div>

      {hasScore && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <Metric
            label="Similarity"
            value={`${((loan.selfieMatchScore ?? 0) * 100).toFixed(1)}%`}
          />
          <Metric
            label="Distance"
            value={(loan.selfieMatchDistance ?? 0).toFixed(3)}
          />
          <Metric
            label="Status"
            value={loan.selfieMatchPassed ? "Likely match" : "Flag for review"}
            tone={loan.selfieMatchPassed ? "good" : "bad"}
          />
          <Metric
            label="Matched at"
            value={
              loan.selfieMatchedAt
                ? new Date(loan.selfieMatchedAt).toLocaleString()
                : "—"
            }
          />
        </div>
      )}

      {hasScore && (
        <div className="flex items-center justify-between gap-2 text-[10px] text-white/45 border-t border-white/5 pt-2">
          <span>
            Model:{" "}
            <span className="font-mono">{loan.selfieMatchModel ?? "—"}</span> ·
            ≥55% similarity = same person threshold
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={runMatch}
            disabled={running}
            className="text-[10px] h-auto py-1 px-2"
          >
            {running ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Re-running…
              </>
            ) : (
              "Re-run"
            )}
          </Button>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-1.5 text-[11px] text-rose-200 border-t border-rose-400/30 pt-2">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
          <span>
            {error}{" "}
            {error.includes("models") && (
              <span className="text-white/55">
                · Model weights couldn't be reached. See{" "}
                <code className="font-mono">
                  apps/web/src/lib/face-match.ts
                </code>{" "}
                for hosting setup.
              </span>
            )}
          </span>
        </div>
      )}

      {!hasScore && !error && (
        <p className="text-[10px] text-white/45">
          Compares the application selfie to the customer's VERIFIED ID photo
          using face-api.js. The compute runs in your browser — neither image
          leaves the machine. Only the resulting similarity score is persisted.
        </p>
      )}
    </div>
  );
}

function ResultBadge({ passed, score }: { passed: boolean; score: number }) {
  return (
    <Badge variant={passed ? "success" : "danger"}>
      {passed ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : (
        <XCircle className="h-3 w-3" />
      )}
      {passed ? "Likely match" : "Flag for review"} · {(score * 100).toFixed(1)}
      %
    </Badge>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad";
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-300"
      : tone === "bad"
        ? "text-rose-300"
        : "text-white/85";
  return (
    <div className="rounded border border-white/5 bg-white/[0.02] px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-white/45">
        {label}
      </div>
      <div className={`text-xs font-medium font-mono ${toneClass}`}>
        {value}
      </div>
    </div>
  );
}
