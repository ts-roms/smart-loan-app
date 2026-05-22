-- Phase 4D: Role inheritance / composition.
--
-- A role can declare zero or more parent roles. The permission
-- resolver walks the graph (with cycle detection) and unions the
-- expanded role set's permissions. Cycles are rejected at write time;
-- the resolver still uses a visited-set for safety.
CREATE TABLE "RoleInheritance" (
  "childId"  TEXT NOT NULL,
  "parentId" TEXT NOT NULL,

  CONSTRAINT "RoleInheritance_pkey" PRIMARY KEY ("childId", "parentId")
);

ALTER TABLE "RoleInheritance"
  ADD CONSTRAINT "RoleInheritance_childId_fkey"
  FOREIGN KEY ("childId") REFERENCES "Role"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RoleInheritance"
  ADD CONSTRAINT "RoleInheritance_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "Role"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- "Who inherits from me?" index — used by the cycle-detection walk
-- at write time and by future "downstream impact" UIs.
CREATE INDEX "RoleInheritance_parentId_idx"
  ON "RoleInheritance"("parentId");
