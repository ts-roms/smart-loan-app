import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DatePicker,
  Input,
  Label,
  useToast,
} from "@loan/ui";
import {
  Banknote,
  Download,
  FileWarning,
  Gavel,
  Layers,
  PhoneCall,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";

import { findArticle, TourButton } from "../../help";
import { todayLocalISO } from "@loan/shared-utils";

/**
 * Compliance Reports — audit requirements across modules.
 *
 * Each card downloads a CSV from the /reports/:type endpoint. JSON is
 * also available by switching the format query param — useful for
 * piping into a BI tool. PDF rendering can come later via @loan/pdf.
 */

interface ReportDef {
  type: string;
  title: string;
  description: string;
  cadence: string;
  needsDateRange: boolean;
  /** Offers province/city inputs — only the collections aging report. */
  hasAreaFilter?: boolean;
  icon: typeof ShieldCheck;
}

const REPORTS: ReportDef[] = [
  {
    type: "collections-aging",
    title: "Collections aging",
    description:
      "Delinquency snapshot at run time — per-account outstanding, days overdue, aging bucket, area and assigned collector. Optionally narrowed to a province / city.",
    cadence: "Weekly",
    needsDateRange: false,
    hasAreaFilter: true,
    icon: PhoneCall,
  },
  {
    type: "dorsi-utilization",
    title: "DORSI utilization",
    description:
      "Per-borrower DORSI exposure with aggregate cap status. Snapshot at run time.",
    cadence: "Quarterly",
    needsDateRange: false,
    icon: ShieldCheck,
  },
  {
    type: "penalty-waivers",
    title: "Penalty waivers",
    description:
      "All penalty waivers in the period — original, waived, negotiated amounts + officer + reason.",
    cadence: "Monthly",
    needsDateRange: true,
    icon: Layers,
  },
  {
    type: "demand-letters",
    title: "Demand letters",
    description:
      "Demand letters drafted in the period — stage, status, approver, dispatcher, outstanding.",
    cadence: "Monthly",
    needsDateRange: true,
    icon: ScrollText,
  },
  {
    type: "repossession-cases",
    title: "Repossession cases",
    description:
      "Cases identified in the period — full state-machine timeline, auction proceeds, deficiency booked.",
    cadence: "Quarterly",
    needsDateRange: true,
    icon: ShieldAlert,
  },
  {
    type: "annual-docs",
    title: "Annual docs compliance",
    description:
      "Current compliance % (valid / expiring / expired) plus per-document detail.",
    cadence: "Quarterly",
    needsDateRange: false,
    icon: FileWarning,
  },
  {
    type: "ecl-movement",
    title: "ECL movement",
    description:
      "IFRS-9 expected-credit-loss runs in the period with stage breakdown + period-over-period delta.",
    cadence: "Monthly",
    needsDateRange: true,
    icon: Banknote,
  },
];

export function ReportsPage() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Gavel className="h-4 w-4 text-info" />
            Compliance reports
          </CardTitle>
          <TourButton
            tourId="reports"
            steps={findArticle("reports")?.tour ?? []}
          />
        </CardHeader>
        <CardContent>
          <p className="text-xs text-fg-muted">
            Audit requirements rendered as exportable CSVs. Each card downloads
            a snapshot — bring it into Excel / Google Sheets for month-end +
            quarter-end reviews.
          </p>
        </CardContent>
      </Card>

      <div
        className="grid grid-cols-1 md:grid-cols-2 gap-3"
        data-tour="reports-grid"
      >
        {REPORTS.map((r) => (
          <ReportCard key={r.type} report={r} />
        ))}
      </div>
    </div>
  );
}

function ReportCard({ report }: { report: ReportDef }) {
  const toast = useToast();
  const today = todayLocalISO();
  const monthAgo = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return todayLocalISO(d);
  })();

  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const [province, setProvince] = useState("");
  const [city, setCity] = useState("");
  const [busy, setBusy] = useState(false);
  const Icon = report.icon;

  const onDownload = async () => {
    setBusy(true);
    try {
      const params = new URLSearchParams({ format: "csv" });
      if (report.needsDateRange) {
        params.set("from", new Date(from).toISOString());
        params.set("to", new Date(to).toISOString());
      }
      // Blank means "everywhere" — the server treats absence as no
      // narrowing, so empty inputs are simply not sent.
      if (report.hasAreaFilter) {
        if (province.trim()) params.set("province", province.trim());
        if (city.trim()) params.set("city", city.trim());
      }
      const token = localStorage.getItem("loan.auth.token");
      const url = `/api/v1/reports/${report.type}?${params.toString()}`;
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }
      const blob = await res.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      // Disposition header dictates filename — browser uses our value as
      // a fallback if disposition is missing.
      link.download = `${report.type}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
      toast.success(`${report.title} downloaded`);
    } catch (err) {
      toast.error((err as Error).message ?? "Download failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <CardTitle className="text-sm flex items-center gap-2">
            <Icon className="h-4 w-4 text-info" />
            {report.title}
          </CardTitle>
        </div>
        <Badge variant="muted">{report.cadence}</Badge>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-fg-muted mb-3">{report.description}</p>
        {report.needsDateRange && (
          <div className="grid grid-cols-2 gap-2 mb-3">
            <div>
              <Label>From</Label>
              <DatePicker value={from} onChange={setFrom} max={to} />
            </div>
            <div>
              <Label>To</Label>
              <DatePicker value={to} onChange={setTo} min={from} />
            </div>
          </div>
        )}
        {/* Free text rather than dropdowns: this page has no queue data
            to build option lists from, and typing the area you already
            know beats loading the whole delinquent book to offer it.
            Matching is case-insensitive server-side. */}
        {report.hasAreaFilter && (
          <div className="grid grid-cols-2 gap-2 mb-3">
            <div>
              <Label>Province</Label>
              <Input
                placeholder="All"
                value={province}
                onChange={(e) => setProvince(e.target.value)}
              />
            </div>
            <div>
              <Label>City</Label>
              <Input
                placeholder="All"
                value={city}
                onChange={(e) => setCity(e.target.value)}
              />
            </div>
          </div>
        )}
        <Button onClick={onDownload} disabled={busy} size="sm">
          <Download className="h-3 w-3" />
          {busy ? "Downloading…" : "Download CSV"}
        </Button>
      </CardContent>
    </Card>
  );
}
