-- Single-use password reset grants.
--
-- Only the SHA-256 of the emailed token is stored, mirroring
-- RefreshToken: a database compromise yields no usable reset links.
-- `usedAt` rather than deletion so a second click can be told apart
-- from an invalid link, and so the reset leaves a trail.

CREATE TABLE "PasswordResetToken" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt"    TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");
-- Supports the sweep of expired rows.
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");

ALTER TABLE "PasswordResetToken"
  ADD CONSTRAINT "PasswordResetToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The notification raised when a reset is requested.
ALTER TYPE "NotificationEvent" ADD VALUE IF NOT EXISTS 'PASSWORD_RESET';
