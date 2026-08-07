import { useAccounts, useCreateAccount, useSeedChart } from "@loan/api-client";
import type { Account } from "@loan/shared-types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonCard,
  useToast,
} from "@loan/ui";
import { Plus, Sparkles } from "lucide-react";
import { useState, type FormEvent } from "react";

import { usePermission } from "../../../hooks/use-permission";

/**
 * The chart of accounts. ADMIN/ACCOUNTANT can add new accounts; everyone
 * can browse. The "Seed" button runs the idempotent default chart upsert
 * (system accounts only) so a fresh DB has all the codes auto-posting
 * references.
 */
export function ChartOfAccountsPage() {
  const accounts = useAccounts();
  const seed = useSeedChart();
  const toast = useToast();
  const canEdit = usePermission("accounting.accounts");
  const [creating, setCreating] = useState(false);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Chart of accounts</CardTitle>
        <div className="flex items-center gap-2">
          {canEdit && (
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  const r = await seed.mutateAsync();
                  toast.success(
                    `Seeded ${r.created} accounts (${r.existing} already present)`,
                  );
                } catch (err) {
                  toast.error((err as Error).message ?? "Could not seed");
                }
              }}
              disabled={seed.isPending}
            >
              <Sparkles className="h-4 w-4" />
              Seed defaults
            </Button>
          )}
          {canEdit && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              New account
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {accounts.isLoading ? (
          <SkeletonCard />
        ) : (accounts.data ?? []).length === 0 ? (
          <p className="text-sm text-fg-muted">
            No accounts yet. Click "Seed defaults" to install the standard
            chart.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
              <tr>
                <th className="py-2 px-2">Code</th>
                <th className="py-2 px-2">Name</th>
                <th className="py-2 px-2">Type</th>
                <th className="py-2 px-2">Normal</th>
                <th className="py-2 px-2">System</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {(accounts.data ?? []).map((a) => (
                <tr key={a.id} className="hover:bg-hover">
                  <td className="py-2 px-2 font-mono">{a.code}</td>
                  <td className="py-2 px-2">
                    {a.name}
                    {a.description && (
                      <div className="text-xs text-fg-subtle">
                        {a.description}
                      </div>
                    )}
                  </td>
                  <td className="py-2 px-2">
                    <Badge variant={typeVariant(a.type)}>{a.type}</Badge>
                  </td>
                  <td className="py-2 px-2 text-fg-muted">{a.normalBalance}</td>
                  <td className="py-2 px-2">
                    {a.system ? <Badge variant="muted">system</Badge> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
      {creating && <NewAccountDialog onClose={() => setCreating(false)} />}
    </Card>
  );
}

function typeVariant(
  type: Account["type"],
): "success" | "danger" | "muted" | "warning" {
  switch (type) {
    case "ASSET":
      return "success";
    case "LIABILITY":
      return "warning";
    case "EQUITY":
      return "muted";
    case "INCOME":
      return "success";
    case "EXPENSE":
      return "danger";
    default:
      return "muted";
  }
}

function NewAccountDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateAccount();
  const toast = useToast();
  const [form, setForm] = useState<{
    code: string;
    name: string;
    type: Account["type"];
    normalBalance: Account["normalBalance"];
    description: string;
  }>({
    code: "",
    name: "",
    type: "ASSET",
    normalBalance: "DEBIT",
    description: "",
  });

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await create.mutateAsync({
        code: form.code,
        name: form.name,
        type: form.type,
        normalBalance: form.normalBalance,
        description: form.description || undefined,
      });
      toast.success("Account created");
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Could not create");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New account</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Code">
              <Input
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                placeholder="2000"
                required
              />
            </Field>
            <Field label="Name">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">
              <Select
                value={form.type}
                onValueChange={(v) =>
                  setForm({
                    ...form,
                    type: v as Account["type"],
                    normalBalance:
                      v === "ASSET" || v === "EXPENSE" ? "DEBIT" : "CREDIT",
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ASSET">Asset</SelectItem>
                  <SelectItem value="LIABILITY">Liability</SelectItem>
                  <SelectItem value="EQUITY">Equity</SelectItem>
                  <SelectItem value="INCOME">Income</SelectItem>
                  <SelectItem value="EXPENSE">Expense</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Normal balance">
              <Select
                value={form.normalBalance}
                onValueChange={(v) =>
                  setForm({
                    ...form,
                    normalBalance: v as Account["normalBalance"],
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="DEBIT">Debit</SelectItem>
                  <SelectItem value="CREDIT">Credit</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Description (optional)">
            <Input
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-fg-muted">{label}</label>
      {children}
    </div>
  );
}
