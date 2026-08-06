import { useBranding, useUpdateBranding, useUpload } from "@loan/api-client";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  SkeletonCard,
  useConfirm,
  useToast,
} from "@loan/ui";
import {
  Building2,
  Image as ImageIcon,
  Trash2,
  Upload,
  Wallet,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../../providers/auth";

/**
 * Branding settings — company name, logo, contact details. Admin-only.
 *
 * Visible to non-admins only as a read-only "Branding" preview row at
 * the bottom so non-admins still know which org they're using; the
 * edit affordances are gated.
 *
 * Logo upload uses the existing /uploads-api/branding subdir (allowed
 * via the upload route's allowlist). Accepts PNG/JPG/WEBP/SVG; SVG is
 * preferred for crisp rendering at every size.
 */
export function BrandingPanel() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const branding = useBranding();
  const update = useUpdateBranding();
  const upload = useUpload();
  const toast = useToast();
  const confirm = useConfirm();
  const fileRef = useRef<HTMLInputElement>(null);

  // Local form state — hydrated from the API once. Kept separate from
  // server state so the user can stage edits and Save them together.
  const [name, setName] = useState("");
  const [tagline, setTagline] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!branding.data) return;
    setName(branding.data.companyName);
    setTagline(branding.data.companyTagline ?? "");
    setAddress(branding.data.companyAddress ?? "");
    setPhone(branding.data.companyPhone ?? "");
    setEmail(branding.data.companyEmail ?? "");
    setWebsite(branding.data.companyWebsite ?? "");
    setLogoUrl(branding.data.companyLogoUrl);
  }, [branding.data]);

  const onPickFile = () => fileRef.current?.click();

  const onFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset the input so the same file can be re-picked if needed.
    e.target.value = "";
    try {
      const result = await upload.mutateAsync({ file, subdir: "branding" });
      setLogoUrl(result.url);
      toast.success("Logo uploaded — Save to apply.");
    } catch (err) {
      toast.error((err as Error).message ?? "Upload failed");
    }
  };

  const onRemoveLogo = async () => {
    const ok = await confirm({
      title: "Remove the company logo?",
      message:
        "The shell will fall back to the built-in glyph until you upload a new one.",
      confirmLabel: "Remove logo",
      tone: "destructive",
    });
    if (!ok) return;
    setLogoUrl(null);
  };

  const onSave = async () => {
    if (!name.trim()) {
      toast.error("Company name is required.");
      return;
    }
    try {
      await update.mutateAsync({
        companyName: name.trim(),
        companyLogoUrl: logoUrl,
        companyTagline: tagline,
        companyAddress: address,
        companyPhone: phone,
        companyEmail: email || undefined,
        companyWebsite: website,
      });
      toast.success("Branding saved. The shell will refresh shortly.");
    } catch (err) {
      toast.error((err as Error).message ?? "Save failed");
    }
  };

  if (branding.isLoading) {
    return <SkeletonCard />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-primary" />
          Company branding
        </CardTitle>
        <p className="text-xs text-fg-muted">
          Name, logo, and contact details used in the sidebar, generated PDFs
          (letterheads), and notification templates.
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Live preview — the same chrome the sidebar shows, so the
            admin sees their edits land before saving. */}
        <BrandingPreview
          name={name || "SmartLoan"}
          tagline={tagline}
          logoUrl={logoUrl}
        />

        {!isAdmin ? (
          // Non-admin: read-only view (preview above is the read-only
          // surface). Stop here.
          <p className="text-[11px] text-fg-subtle">
            Only administrators can edit branding. Ask an admin if you need a
            change.
          </p>
        ) : (
          <>
            {/* Identity block */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="md:col-span-2">
                <Label>Company name *</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  placeholder="e.g. Bayan Cooperative"
                />
              </div>
              <div className="md:col-span-2">
                <Label>Tagline</Label>
                <Input
                  value={tagline}
                  onChange={(e) => setTagline(e.target.value)}
                  maxLength={120}
                  placeholder="Shown beneath the brand glyph in the sidebar"
                />
              </div>
            </div>

            {/* Logo */}
            <div className="space-y-2">
              <Label>Logo</Label>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="h-16 w-16 rounded-md border border-default bg-surface-3 flex items-center justify-center overflow-hidden">
                  {logoUrl ? (
                    <img
                      src={logoUrl}
                      alt="Logo preview"
                      className="max-h-full max-w-full object-contain"
                    />
                  ) : (
                    <ImageIcon className="h-6 w-6 text-fg-subtle" />
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onPickFile}
                    disabled={upload.isPending}
                  >
                    <Upload className="h-3.5 w-3.5" />
                    {upload.isPending
                      ? "Uploading…"
                      : logoUrl
                        ? "Replace"
                        : "Upload"}
                  </Button>
                  {logoUrl && (
                    <Button variant="ghost" size="sm" onClick={onRemoveLogo}>
                      <Trash2 className="h-3.5 w-3.5" />
                      Remove
                    </Button>
                  )}
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  onChange={onFileChosen}
                  className="hidden"
                />
              </div>
              <p className="text-[11px] text-fg-subtle">
                PNG, JPG, WEBP, or SVG. SVG renders crispest at every size.
                Squareish proportions work best — the sidebar slot is 32×32px.
              </p>
            </div>

            {/* Contact details */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 border-t border-default pt-3">
              <div className="md:col-span-2">
                <Label>Postal address</Label>
                <Input
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  maxLength={500}
                  placeholder="Used on PDF letterheads"
                />
              </div>
              <div>
                <Label>Phone</Label>
                <Input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  maxLength={40}
                />
              </div>
              <div>
                <Label>Email</Label>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  maxLength={120}
                />
              </div>
              <div className="md:col-span-2">
                <Label>Website</Label>
                <Input
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  maxLength={200}
                  placeholder="https://example.coop"
                />
              </div>
            </div>

            <div className="flex justify-end">
              <Button onClick={onSave} loading={update.isPending}>
                Save branding
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Preview — mirrors the sidebar chrome ────────────────────────────

function BrandingPreview({
  name,
  tagline,
  logoUrl,
}: {
  name: string;
  tagline: string;
  logoUrl: string | null;
}) {
  return (
    <div className="rounded-md border border-default bg-surface-2 p-3">
      <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-2">
        Sidebar preview
      </div>
      <div className="flex items-center gap-2.5">
        <div className="h-8 w-8 rounded-md bg-primary-soft border border-default flex items-center justify-center overflow-hidden">
          {logoUrl ? (
            <img
              src={logoUrl}
              alt=""
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <Wallet className="h-4 w-4 text-primary" />
          )}
        </div>
        <div className="min-w-0">
          <div className="text-[15px] font-semibold tracking-tight leading-tight truncate">
            {name}
          </div>
          {tagline && (
            <div className="text-[10px] uppercase tracking-wider text-fg-subtle leading-tight truncate">
              {tagline}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
