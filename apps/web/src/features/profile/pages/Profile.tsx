import { useMyPermissions, useMyProfile } from "@loan/api-client";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SkeletonCard,
} from "@loan/ui";
import { formatDate } from "@loan/shared-utils";
import {
  Mail,
  Settings as SettingsIcon,
  ShieldCheck,
  UserCircle,
} from "lucide-react";
import { Link } from "react-router-dom";

import { useAuth } from "../../../providers/auth";

/**
 * My profile — read-only view of the signed-in user's identity, primary
 * role, assigned RBAC roles, and effective permission count. Editable
 * bits (signature, future preferences) live on /settings.
 */
export function ProfilePage() {
  const { user } = useAuth();
  const me = useMyProfile();
  const myPerms = useMyPermissions();

  if (!user) return null;
  if (me.isLoading) return <SkeletonCard />;

  const profile = me.data;
  const assignedRoles = myPerms.data?.roles ?? [];
  const permCount = myPerms.data?.permissions.length ?? 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserCircle className="h-4 w-4 text-info" />
            My profile
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-4">
            <Avatar name={user.name} size="lg" />
            <div className="flex-1 min-w-0">
              <div className="text-lg font-semibold">{user.name}</div>
              <div className="text-sm text-fg-muted flex items-center gap-1.5 mt-0.5">
                <Mail className="h-3 w-3" />
                {user.email}
              </div>
              <div className="text-xs uppercase tracking-wider text-info mt-1">
                {user.role}
              </div>
              {profile?.createdAt && (
                <div className="text-xs text-fg-subtle mt-2">
                  Joined {formatDate(profile.createdAt)}
                </div>
              )}
            </div>
            <Button variant="outline" size="sm" asChild>
              <Link to="/settings">
                <SettingsIcon className="h-3.5 w-3.5" />
                Edit settings
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-success" />
            Roles & permissions
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-fg-subtle mb-1.5">
              Assigned roles
            </div>
            {assignedRoles.length === 0 ? (
              <p className="text-sm text-fg-muted">No roles assigned.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {assignedRoles.map((r) => (
                  <span
                    key={r.key}
                    className="inline-flex items-center gap-1 rounded-full border border-default bg-surface-2 px-2.5 py-0.5 text-xs"
                  >
                    <span className={r.system ? "text-info" : "text-success"}>
                      {r.name}
                    </span>
                    {r.system && <Badge variant="muted">System</Badge>}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-fg-subtle mb-1.5">
              Effective permissions
            </div>
            <p className="text-sm">
              <span className="font-mono">{permCount}</span>{" "}
              <span className="text-fg-muted">
                permission{permCount === 1 ? "" : "s"} active (your roles + any
                held delegations)
              </span>
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
