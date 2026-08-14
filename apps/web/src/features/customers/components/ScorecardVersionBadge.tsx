import {
  useScoringCatalogHistory,
  useScoringCatalogVersion,
  type ScoringCatalogChangeType,
  type ScoringCatalogVersionSummary,
} from "@loan/api-client";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  SkeletonCard,
} from "@loan/ui";
import { useState } from "react";

/**
 * Which scorecard produced a score, and what that scorecard said.
 *
 * §20 requires a decision be explainable, and the scorecard used is
 * stored on every CreditScore — but until now nothing read it back, so
 * an officer looking at 712 could not tell whether it came from the
 * weights in force today or the ones in force last March. Reading
 * today's scorecard to explain last March's number is not an audit
 * trail; it is a guess that looks like one.
 *
 * Deliberately the same idiom as the decision-rule version badge: a
 * version number shown on every score, which opens the change log. A
 * second, different affordance for the same question would be one more
 * thing to learn for no gain (§80).
 */
export function ScorecardVersionBadge({
  catalogVersion,
}: {
  /** The version stamped on THIS score. Never the current one. */
  catalogVersion: number | null;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/*
        Shown for every score, including one scored under v1. A version
        that appeared only on old scores would read as a warning badge;
        present on all of them it reads as what it is — which scorecard
        this number came from.
      */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="View scorecard history"
        /*
          The visible label is "v3", which as an accessible name tells a
          screen-reader user nothing — and `title` does not win against
          text content. Named explicitly so the control announces what
          it does and which version it is announcing.
        */
        aria-label={
          catalogVersion === null
            ? "View scorecard history (scorecard version not recorded for this score)"
            : `View scorecard history (this score used scorecard v${catalogVersion})`
        }
        className="rounded px-1 font-mono text-[10px] text-fg-subtle hover:bg-hover hover:text-info"
      >
        {catalogVersion === null
          ? "scorecard not recorded"
          : `v${catalogVersion}`}
      </button>
      {open && (
        <ScorecardHistoryDialog
          scoredUnder={catalogVersion}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/**
 * Every revision of the scorecard, newest first.
 *
 * A list rather than a diff, for the same reason the rule history is:
 * what a reviewer needs is what the scorecard SAID in a period, and a
 * diff shows the change while hiding the state.
 */
function ScorecardHistoryDialog({
  scoredUnder,
  onClose,
}: {
  scoredUnder: number | null;
  onClose: () => void;
}) {
  const history = useScoringCatalogHistory();
  const versions = history.data ?? [];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Scorecard history</DialogTitle>
        </DialogHeader>
        {scoredUnder === null ? (
          /*
            The honest reading of a null. This score predates catalog
            versioning, so the scorecard of the day was never written
            down — and the current one is emphatically not it. Saying so
            is the whole point; showing today's version here would
            fabricate the audit trail this panel exists to provide.
          */
          <p className="text-xs text-warning">
            This score was computed before the scorecard was versioned, so which
            scorecard produced it was never recorded. The revisions below are
            the ones on file — none of them is known to be the one used.
          </p>
        ) : (
          <p className="text-xs text-fg-muted">
            This score was computed under v{scoredUnder}. Each entry is the
            scorecard as it stood for that period; scores computed inside a
            period were computed with those weights.
          </p>
        )}
        {history.isLoading ? (
          <SkeletonCard />
        ) : versions.length === 0 ? (
          <p className="text-sm text-fg-muted">No history recorded.</p>
        ) : (
          <ol className="max-h-[26rem] space-y-2 overflow-y-auto">
            {versions.map((v) => (
              <VersionEntry
                key={v.id}
                version={v}
                scoredUnder={v.version === scoredUnder}
              />
            ))}
          </ol>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const CHANGE_LABELS: Record<ScoringCatalogChangeType, string> = {
  BASELINE: "Baseline",
  FACTOR_ADDED: "Factor added",
  FACTOR_CHANGED: "Factor changed",
  FACTOR_REMOVED: "Factor removed",
  QUESTION_ADDED: "Question added",
  QUESTION_CHANGED: "Question changed",
  QUESTION_REMOVED: "Question removed",
  REORDERED: "Reordered",
};

function VersionEntry({
  version: v,
  scoredUnder,
}: {
  version: ScoringCatalogVersionSummary;
  scoredUnder: boolean;
}) {
  const [showSnapshot, setShowSnapshot] = useState(false);
  const current = v.effectiveTo === null;

  return (
    <li className="rounded-md border border-default p-3 text-xs">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="font-mono text-fg-subtle">v{v.version}</span>
        <Badge variant="muted">{CHANGE_LABELS[v.changeType]}</Badge>
        {current && <Badge variant="info">Current</Badge>}
        {/*
          The reason this panel was opened. Without it the officer has to
          match a number in the badge against a row by eye, which is
          exactly the step that gets skipped.
        */}
        {scoredUnder && <Badge variant="success">Scored under this</Badge>}
      </div>
      <div className="mb-1.5 text-fg-subtle">
        In force {fmt(v.effectiveFrom)} —{" "}
        {v.effectiveTo ? fmt(v.effectiveTo) : "now"}
        <span className="mx-1.5">·</span>
        {v.factorCount} factors, {v.questionCount} questions
      </div>
      {v.changeSummary && <p className="text-fg-muted">{v.changeSummary}</p>}
      {v.changeNote && (
        <p className="mt-1.5 italic text-fg-subtle">{v.changeNote}</p>
      )}
      <button
        type="button"
        onClick={() => setShowSnapshot((s) => !s)}
        aria-expanded={showSnapshot}
        className="mt-1.5 text-fg-muted underline hover:text-info"
      >
        {showSnapshot ? "Hide scorecard" : `Show scorecard as of v${v.version}`}
      </button>
      {showSnapshot && <SnapshotDetail version={v.version} />}
    </li>
  );
}

/**
 * What the scorecard actually said at that revision.
 *
 * Mounted only when expanded, so opening the panel costs one list
 * request rather than a snapshot of the whole catalog per row.
 *
 * Weights are shown raw, as stored. They are relative shares that the
 * server normalizes onto a fixed point total, and resolving them into
 * points here would be a second implementation of the apportionment —
 * which is precisely how a UI and a scorer come to disagree about what
 * a factor was worth. The list endpoint serves resolved points for the
 * CURRENT catalog; no equivalent exists for a historical snapshot.
 */
function SnapshotDetail({ version }: { version: number }) {
  const detail = useScoringCatalogVersion(version);

  if (detail.isLoading) {
    return <p className="mt-1.5 text-fg-muted">Loading scorecard…</p>;
  }
  const factors = detail.data?.snapshot?.factors ?? [];
  if (factors.length === 0) {
    return (
      <p className="mt-1.5 text-fg-muted">
        No scorecard recorded for this revision.
      </p>
    );
  }

  return (
    <ul className="mt-1.5 space-y-0.5 border-t border-default pt-1.5 font-mono text-fg-muted">
      {factors.map((f) => (
        <li key={f.id} className="flex justify-between gap-2">
          <span>
            {f.label}
            {f.computed && (
              <span className="ml-1 not-italic text-fg-subtle">(computed)</span>
            )}
          </span>
          <span>weight {f.weight}</span>
        </li>
      ))}
    </ul>
  );
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
