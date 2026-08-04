import {
  useAnnualDocs,
  useCreateAnnualDoc,
  useDeleteAnnualDoc,
  useMyPermissions,
} from "@loan/api-client";
import type { AnnualDocumentType } from "@loan/shared-types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DatePicker,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonLine,
  useConfirm,
  useToast,
} from "@loan/ui";
import { formatDate } from "@loan/shared-utils";
import {
  CalendarClock,
  FileWarning,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useState } from "react";

const TYPE_LABELS: Record<AnnualDocumentType, string> = {
  CAR_INSURANCE: "Car insurance",
  OR_CR: "OR / CR",
  RPT: "Real property tax",
  FIRE_INSURANCE: "Fire insurance",
  OTHER: "Other",
};

/**
 * AnnualDocsPanel surface on the loan detail page.
 *
 * Lists every renewable document (car insurance, RPT, OR/CR, fire
 * insurance) with its expiry-aware status badge. Officers with
 * `loans.docs_renew` can add a new submission. The daily reminder job
 * automatically warns the borrower 30 days before expiry; this panel is
 * the place where staff record receipt of the renewal.
 */
export function AnnualDocsPanel({ loanId }: { loanId: string }) {
  const docs = useAnnualDocs(loanId);
  const me = useMyPermissions();
  const canManage = (me.data?.permissions ?? []).includes("loans.docs_renew");
  const [open, setOpen] = useState(false);
  const list = docs.data ?? [];

  // Hide the whole panel when nothing's tracked and the current user can't
  // add docs — keeps the page tidy for non-officer viewers.
  if (!docs.isLoading && list.length === 0 && !canManage) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-info" />
          Renewable documents
        </CardTitle>
        {canManage && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <Plus className="h-3 w-3" />
            Record renewal
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {docs.isLoading ? (
          <SkeletonLine />
        ) : list.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No renewable docs tracked yet. Car insurance and other annual
            documents required by the product policy go here.
          </p>
        ) : (
          <div className="rounded-md border border-default bg-surface-2 divide-y divide-default">
            {list.map((d) => (
              <DocRow
                key={d.id}
                doc={d}
                canManage={canManage}
                loanId={loanId}
              />
            ))}
          </div>
        )}
      </CardContent>

      {open && <NewDocDialog loanId={loanId} onClose={() => setOpen(false)} />}
    </Card>
  );
}

function DocRow({
  doc,
  canManage,
  loanId,
}: {
  doc: import("@loan/shared-types").AnnualDocument;
  canManage: boolean;
  loanId: string;
}) {
  const del = useDeleteAnnualDoc();
  const confirm = useConfirm();
  const toast = useToast();

  const onDelete = async () => {
    const ok = await confirm({
      title: "Remove renewable doc?",
      message: `Delete "${doc.name}"? This only removes the tracking record, not the underlying document.`,
      confirmLabel: "Remove",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      await del.mutateAsync({ id: doc.id, loanId });
      toast.success("Renewable doc removed");
    } catch (err) {
      toast.error((err as Error).message ?? "Remove failed");
    }
  };

  return (
    <div className="px-3 py-2 text-xs flex items-start justify-between gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-fg">{doc.name}</span>
          <Badge variant="muted">{TYPE_LABELS[doc.type]}</Badge>
          <StatusBadge status={doc.status} />
        </div>
        <div className="text-[10px] text-fg-muted mt-0.5 flex items-center gap-2">
          <CalendarClock className="h-3 w-3" />
          <span>
            {formatDate(doc.effectiveFrom)} → {formatDate(doc.expiresAt)}
          </span>
          {doc.documentUrl && (
            <a
              href={doc.documentUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-info hover:underline"
            >
              view
            </a>
          )}
        </div>
        {doc.notes && (
          <p className="text-[10px] text-fg-muted mt-0.5">{doc.notes}</p>
        )}
      </div>
      {canManage && (
        <Button
          size="sm"
          variant="outline"
          onClick={onDelete}
          disabled={del.isPending}
          aria-label="Remove renewable doc"
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}

function StatusBadge({
  status,
}: {
  status: "VALID" | "EXPIRING_SOON" | "EXPIRED";
}) {
  if (status === "VALID") return <Badge variant="success">Valid</Badge>;
  if (status === "EXPIRING_SOON")
    return (
      <Badge variant="warning" title="Expires within 30 days">
        Expiring soon
      </Badge>
    );
  return (
    <Badge variant="danger" title="Past expiry — borrower must renew">
      <FileWarning className="h-3 w-3" />
      Expired
    </Badge>
  );
}

function NewDocDialog({
  loanId,
  onClose,
}: {
  loanId: string;
  onClose: () => void;
}) {
  const create = useCreateAnnualDoc();
  const toast = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const oneYearFromNow = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().slice(0, 10);
  })();

  const [type, setType] = useState<AnnualDocumentType>("CAR_INSURANCE");
  const [name, setName] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [expiresAt, setExpiresAt] = useState(oneYearFromNow);
  const [documentUrl, setDocumentUrl] = useState("");
  const [notes, setNotes] = useState("");

  const onSubmit = async () => {
    if (!name.trim()) {
      toast.error("Name required");
      return;
    }
    if (new Date(expiresAt) <= new Date(effectiveFrom)) {
      toast.error("Expiry must be after effective date");
      return;
    }
    try {
      await create.mutateAsync({
        loanId,
        type,
        name: name.trim(),
        effectiveFrom: new Date(effectiveFrom).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        documentUrl: documentUrl.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      toast.success("Renewable doc recorded");
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Save failed");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record renewable document</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Type</Label>
              <Select
                value={type}
                onValueChange={(v) => setType(v as AnnualDocumentType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(
                    Object.entries(TYPE_LABELS) as Array<
                      [AnnualDocumentType, string]
                    >
                  ).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Comprehensive insurance 2026-2027"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Effective from</Label>
              <DatePicker value={effectiveFrom} onChange={setEffectiveFrom} />
            </div>
            <div>
              <Label>Expires at</Label>
              <DatePicker
                value={expiresAt}
                onChange={setExpiresAt}
                min={effectiveFrom}
              />
            </div>
          </div>
          <div>
            <Label>Document URL (optional)</Label>
            <Input
              value={documentUrl}
              onChange={(e) => setDocumentUrl(e.target.value)}
              placeholder="https://… (uploaded scan)"
            />
          </div>
          <div>
            <Label>Notes (optional)</Label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Provider, policy ref, etc."
            />
          </div>
          <p className="text-[10px] text-fg-subtle">
            The borrower receives a 30-day reminder before expiry; an escalation
            goes out if the doc lapses past the due date.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={onSubmit}
            disabled={create.isPending || !name.trim()}
          >
            {create.isPending ? "Saving…" : "Save renewal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
