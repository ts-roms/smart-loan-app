import { useNotifications, useSendTestNotification } from "@loan/api-client";
import type { NotificationChannel } from "@loan/shared-types";
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
import { formatDateTime } from "@loan/shared-utils";
import { ChevronRight, Mail, Send } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

import { usePermission } from "../../../hooks/use-permission";
import { notificationLink } from "../links";

/** Mirrors NotificationRepository.list's default `take`. */
const NOTIFICATION_PAGE_CAP = 100;

/**
 * The notification log — every message the system has sent.
 *
 * Read as an ops log rather than an inbox: the column people come here
 * for is Status, because a FAILED row means a borrower never got told
 * something the system believes it told them.
 */
export function NotificationsPage() {
  const notifs = useNotifications();
  /*
   * The permission, not `user.role === "ADMIN"`.
   *
   * The endpoint gates on `notifications.test`, and RBAC resolves
   * permissions from role ASSIGNMENTS — `User.role` is the legacy enum
   * kept for back-compat. Checking it got the right answer only because
   * the four seeded roles happen to line up: a custom role granting
   * `notifications.test` to someone whose enum says ACCOUNTANT hid the
   * button, and an enum still reading ADMIN after the assignment was
   * revoked showed a button that 403s.
   */
  const canTest = usePermission("notifications.test");
  const [testing, setTesting] = useState(false);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-4 w-4" />
          Notifications
        </CardTitle>
        {canTest && (
          <Button variant="outline" onClick={() => setTesting(true)}>
            <Send className="h-3 w-3" />
            Send test
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {notifs.isLoading ? (
          <SkeletonCard />
        ) : (notifs.data ?? []).length === 0 ? (
          <p className="text-sm text-fg-muted">No notifications sent yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
              <tr>
                <th className="py-2 px-2">When</th>
                <th className="py-2 px-2">Event</th>
                <th className="py-2 px-2">Channel</th>
                <th className="py-2 px-2">Recipient</th>
                <th className="py-2 px-2">Subject / preview</th>
                <th className="py-2 px-2">Status</th>
                <th className="py-2 px-2 sr-only">Open</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {(notifs.data ?? []).map((n) => (
                <tr key={n.id} className="hover:bg-hover align-top">
                  <td className="py-2 px-2 text-xs text-fg-muted">
                    {formatDateTime(n.createdAt)}
                  </td>
                  <td className="py-2 px-2 text-xs">
                    <Badge variant="muted">{n.event}</Badge>
                  </td>
                  <td className="py-2 px-2 text-xs">{n.channel}</td>
                  <td className="py-2 px-2 text-xs">{n.recipient}</td>
                  <td className="py-2 px-2 max-w-[40ch]">
                    <div className="text-xs font-medium truncate">
                      {n.subject ?? ""}
                    </div>
                    <div className="text-xs text-fg-muted truncate">
                      {n.body}
                    </div>
                  </td>
                  <td className="py-2 px-2">
                    <Badge
                      variant={
                        n.status === "SENT"
                          ? "success"
                          : n.status === "FAILED"
                            ? "danger"
                            : "warning"
                      }
                    >
                      {n.status}
                    </Badge>
                    {n.error && (
                      <div className="text-xs text-danger mt-1">{n.error}</div>
                    )}
                  </td>
                  {/* Its own column rather than a clickable row: the
                      row already holds a recipient address people
                      select and copy, and a row-wide link makes that
                      a navigation instead. */}
                  <td className="py-2 px-2">
                    {notificationLink(n) && (
                      <Link
                        to={notificationLink(n)!}
                        className="inline-flex items-center gap-0.5 text-xs text-info hover:underline"
                      >
                        Open
                        <ChevronRight className="h-3 w-3" />
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {(notifs.data ?? []).length >= NOTIFICATION_PAGE_CAP && (
          /*
             The endpoint caps at 100 and says nothing about it. A log
             that stops silently reads as "this is everything", which is
             the one thing it must not say — the row you came looking
             for is the oldest FAILED one, and it is exactly the row a
             silent cap drops.
          */
          <p className="mt-3 text-[11px] text-fg-subtle">
            Showing the most recent {NOTIFICATION_PAGE_CAP}. Older notifications
            are not listed.
          </p>
        )}
      </CardContent>
      {testing && <TestDialog onClose={() => setTesting(false)} />}
    </Card>
  );
}

function TestDialog({ onClose }: { onClose: () => void }) {
  const send = useSendTestNotification();
  const toast = useToast();
  const [channel, setChannel] = useState<NotificationChannel>("EMAIL");
  const [recipient, setRecipient] = useState("");
  const [note, setNote] = useState("Hello from the test endpoint.");

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await send.mutateAsync({ channel, recipient, note });
      toast.success("Test sent (check console for mock output)");
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send test notification</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Channel">
              <Select
                value={channel}
                onValueChange={(v) => setChannel(v as NotificationChannel)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="EMAIL">Email</SelectItem>
                  <SelectItem value="SMS">SMS</SelectItem>
                  <SelectItem value="IN_APP">In-app</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Recipient">
              <Input
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder={
                  channel === "EMAIL" ? "name@example.com" : "+639xx…"
                }
                required
              />
            </Field>
          </div>
          <Field label="Note">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={send.isPending}
              disabled={!recipient}
            >
              Send
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
