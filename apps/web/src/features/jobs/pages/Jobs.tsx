import {
  useJobRuns,
  useJobs,
  useRunJob,
  useSetJobEnabled,
  useUpdateJobCron,
} from "@loan/api-client";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  SkeletonCard,
  useToast,
} from "@loan/ui";
import { formatDateTime } from "@loan/shared-utils";
import { Play, Settings } from "lucide-react";
import { useState } from "react";

import { useAuth } from "../../../providers/auth";

/**
 * Scheduled jobs admin. Lists every registered job with its cron, enabled
 * flag, last-run timestamp, and a manual-trigger button. Picking a job
 * reveals its run history (last 50 runs).
 */
export function JobsPage() {
  const jobs = useJobs();
  const run = useRunJob();
  const setEnabled = useSetJobEnabled();
  const updateCron = useUpdateJobCron();
  const toast = useToast();
  const { user } = useAuth();
  const [selected, setSelected] = useState<string | null>(null);
  const [editingCron, setEditingCron] = useState<string | null>(null);
  const [cronDraft, setCronDraft] = useState("");

  const canAdmin = user?.role === "ADMIN";
  const canRun = canAdmin || user?.role === "ACCOUNTANT";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Scheduled jobs</CardTitle>
        </CardHeader>
        <CardContent>
          {jobs.isLoading ? (
            <SkeletonCard />
          ) : (jobs.data ?? []).length === 0 ? (
            <p className="text-sm text-fg-muted">No jobs registered.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
                <tr>
                  <th className="py-2 px-2">Name</th>
                  <th className="py-2 px-2">Cron</th>
                  <th className="py-2 px-2">Next run</th>
                  <th className="py-2 px-2">Last run</th>
                  <th className="py-2 px-2">Status</th>
                  <th className="py-2 px-2 text-right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-default">
                {(jobs.data ?? []).map((j) => (
                  <tr
                    key={j.id}
                    onClick={() => setSelected(j.name)}
                    className={`hover:bg-hover cursor-pointer ${selected === j.name ? "bg-surface-3" : ""}`}
                  >
                    <td className="py-2 px-2">
                      <div className="font-medium">{j.name}</div>
                      {j.description && (
                        <div className="text-xs text-fg-subtle">
                          {j.description}
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-2 font-mono text-xs">
                      {editingCron === j.name ? (
                        <div
                          className="flex items-center gap-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Input
                            value={cronDraft}
                            onChange={(e) => setCronDraft(e.target.value)}
                            className="h-7 w-32 text-xs"
                          />
                          <Button
                            size="sm"
                            onClick={async () => {
                              try {
                                await updateCron.mutateAsync({
                                  name: j.name,
                                  cron: cronDraft,
                                });
                                toast.success("Cron updated");
                                setEditingCron(null);
                              } catch (err) {
                                toast.error((err as Error).message ?? "Failed");
                              }
                            }}
                          >
                            Save
                          </Button>
                        </div>
                      ) : (
                        <span
                          onClick={(e) => {
                            if (!canAdmin) return;
                            e.stopPropagation();
                            setEditingCron(j.name);
                            setCronDraft(j.cron);
                          }}
                          className={canAdmin ? "hover:underline" : ""}
                        >
                          {j.cron}
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-2 text-xs text-fg-muted">
                      {j.nextRunAt ? formatDateTime(j.nextRunAt) : "—"}
                    </td>
                    <td className="py-2 px-2 text-xs text-fg-muted">
                      {j.lastRunAt ? formatDateTime(j.lastRunAt) : "never"}
                    </td>
                    <td className="py-2 px-2">
                      <Badge variant={j.enabled ? "success" : "muted"}>
                        {j.enabled ? "Enabled" : "Paused"}
                      </Badge>
                    </td>
                    <td
                      className="py-2 px-2 text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center justify-end gap-1">
                        {canAdmin && (
                          <button
                            type="button"
                            title={j.enabled ? "Pause" : "Resume"}
                            className="text-fg-muted hover:text-info"
                            onClick={async () => {
                              try {
                                await setEnabled.mutateAsync({
                                  name: j.name,
                                  enabled: !j.enabled,
                                });
                              } catch (err) {
                                toast.error((err as Error).message ?? "Failed");
                              }
                            }}
                          >
                            <Settings className="h-3 w-3" />
                          </button>
                        )}
                        {canRun && (
                          <button
                            type="button"
                            title="Run now"
                            className="text-fg-muted hover:text-success"
                            onClick={async () => {
                              try {
                                const r = await run.mutateAsync(j.name);
                                toast.success(
                                  r.status === "SUCCEEDED"
                                    ? `Ran ${j.name}`
                                    : `${j.name} failed: ${r.error ?? "see logs"}`,
                                );
                              } catch (err) {
                                toast.error((err as Error).message ?? "Failed");
                              }
                            }}
                          >
                            <Play className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {selected && <JobRuns name={selected} />}
    </div>
  );
}

function JobRuns({ name }: { name: string }) {
  const runs = useJobRuns(name);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent runs · {name}</CardTitle>
      </CardHeader>
      <CardContent>
        {runs.isLoading ? (
          <SkeletonCard />
        ) : (runs.data ?? []).length === 0 ? (
          <p className="text-sm text-fg-muted">No runs yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
              <tr>
                <th className="py-2 px-2">Started</th>
                <th className="py-2 px-2">Status</th>
                <th className="py-2 px-2">Duration</th>
                <th className="py-2 px-2">Result / Error</th>
                <th className="py-2 px-2">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {(runs.data ?? []).map((r) => {
                const duration = r.finishedAt
                  ? `${((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000).toFixed(2)}s`
                  : "—";
                return (
                  <tr key={r.id} className="hover:bg-hover">
                    <td className="py-2 px-2 text-xs text-fg-muted">
                      {formatDateTime(r.startedAt)}
                    </td>
                    <td className="py-2 px-2">
                      <Badge
                        variant={
                          r.status === "SUCCEEDED"
                            ? "success"
                            : r.status === "FAILED"
                              ? "danger"
                              : "warning"
                        }
                      >
                        {r.status}
                      </Badge>
                    </td>
                    <td className="py-2 px-2 text-xs">{duration}</td>
                    <td className="py-2 px-2 text-xs text-fg-muted max-w-[40ch]">
                      <div className="truncate">
                        {r.error ?? (r.result ? JSON.stringify(r.result) : "—")}
                      </div>
                    </td>
                    <td className="py-2 px-2 text-xs">
                      {r.manual ? (
                        <Badge variant="warning">manual</Badge>
                      ) : (
                        <Badge variant="muted">scheduled</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
