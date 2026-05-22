# Smoke-test checklist — customer onboarding + KYC + DORSI

Last refreshed after the API restructure (28 features now live under
`apps/api/src/features/<feature>/`) and the customer-onboarding upgrades
that landed without end-to-end verification (KYC dedup, DORSI
CustomerPicker, bulk import, wider modal, email required, address
cascade).

The whole API contract is unchanged — URL prefixes, request schemas,
permission gates all identical. So this checklist exercises behaviour,
not topology.

## How to start

Postgres runs natively on the host (see README for one-time setup).
With the database up and `.env` configured:

```bash
pnpm db:generate
pnpm db:migrate                   # or `prisma migrate reset` to wipe + reseed
pnpm db:seed                      # seeds admin / officer / accountant users
pnpm dev                          # api + web in parallel, hot reload
```

Then visit:

- http://localhost:5173 — web app (Vite dev server)
- http://localhost:3001/docs — Swagger UI

### Seed accounts

After `pnpm db:seed`, the following accounts exist:

- **admin@loan.local / admin** — ADMIN role (sees everything)
- **officer@loan.local / officer** — LOAN_OFFICER (no admin / accounting)
- **accountant@loan.local / accountant** — ACCOUNTANT
- **customer@loan.local / customer** — CUSTOMER (borrower portal only)

For most of this checklist, sign in as **admin**. Switch to officer/customer where each section calls it out.

### Running the unit tests (sanity check)

Before driving the browser, you can confirm pure-logic code is healthy:

```bash
pnpm --filter @loan/kyc test          # 12 tests
pnpm --filter @loan/accounting test   # 22 tests
pnpm --filter @loan/loans test        # 32 tests
pnpm --filter @loan/db test           # 18 tests (dorsi-helpers)
# or all at once:
pnpm test
```

All four suites should pass. If they don't, fix that before browsing —
the browser will hit the same bugs in awkward places.

---

## 1. New customer (wider modal + email required + address cascade)

**Goal**: confirm the customer-create flow accepts the expanded form and
the address cascade scopes its children correctly.

- [ ] Open **/customers → "New customer"**.
- [ ] Modal renders at `max-w-5xl` (visibly wider than before — the
      2-column sections breathe instead of hugging the left edge).
- [ ] Email field shows a **red asterisk**; submitting without an
      email surfaces a 400 with `path: ["email"]`.
- [ ] Type a valid email and required fields → submit succeeds, returns
      201 + a new CUST-YYYY-NNNNNN reference.
- [ ] Open the modal again. In the Address section:
  - [ ] Pick **Region = NCR**. The Province row hides ("NCR has no
        provinces"). The City field's suggestion list now shows all 17
        NCR cities (Caloocan, Las Piñas, Makati, …).
  - [ ] Pick **City = Quezon City**. The Barangay suggestion list
        scopes to ~8 QC barangays (Batasan Hills, Commonwealth, …).
  - [ ] Change Region to **Region IV-A (CALABARZON)**. City + Barangay
        clear automatically (cascade reset).
  - [ ] Pick **Province = Laguna**. City suggestions now show Sta.
        Cruz / Calamba / San Pedro.
  - [ ] Type a city that isn't in the bundle (e.g., "Biñan"). The
        suggestion list stays empty and the small `emptyHint` caption
        ("No bundled cities for this area — type the name.") shows.
        Submit still works.
  - [ ] Type a barangay that isn't in the bundle. Same caption appears.
        Submit succeeds.

## 2. Edit customer

- [ ] Open any customer detail page → **"Edit profile"** (Pencil icon).
- [ ] Dialog opens at `max-w-5xl`. Form pre-populates from the existing
      record (firstName, address, employment, etc.).
- [ ] Change one field, save → 200, toast shows "Customer profile
      updated".
- [ ] **Address cascade hydration**: editing a customer whose Region is
      already set should leave Province / City / Barangay populated.
      Changing Region only clears the downstream fields.

## 3. Bulk CSV customer import

- [ ] Open **/customers/bulk** (also reachable from "Bulk import" button
      on /customers and the sidebar nav under "Customers & loans").
- [ ] Click **Template** → downloads `customers-template.csv`.
- [ ] Drop the template back into the FileDropzone. Preview table shows
      2 sample rows (Juan / Maria).
- [ ] Click **Dry run** → 207 response, both rows pass validation, toast
      "Dry run OK — 2 row(s) would be created."
- [ ] Modify one row's `firstName` to empty in the textarea. Parse error
      shows "firstName and lastName are required" pointing at the line.
- [ ] Restore the row and remove `email` from header + row data. Dry run
      should now report `email: Required` for that row (the email-required
      schema flowed all the way through).
- [ ] Add a valid email back. Click **Import 2 customers** → 207, both
      rows commit, results table shows the CUST-… numbers as clickable
      links into each new customer's detail page.

## 4. KYC submit (camera + upload + dedup 409)

On a customer detail page:

- [ ] **Doc-type dropdown filters** — types that already have a PENDING
      or VERIFIED submission don't appear. Initially all 9 types should
      be available.
- [ ] Pick **Government ID (front)**. The capture area shows "Open
      camera" + "or upload a file" (capture mode = `environment` for ID
      docs).
- [ ] Click "Open camera". Browser asks for camera permission. Grant.
      Live preview appears. Snap a photo. Preview shows the captured
      image. Click "Use this photo" → uploads to /uploads-api/kyc and
      fills the document URL.
- [ ] Click **Submit document** → 201 + the doc appears in the list
      above as PENDING.
- [ ] Pick **Government ID (front)** again from the dropdown — **it's
      no longer in the list** (filtered out because there's a PENDING
      submission).
- [ ] Open a second browser tab. From the same customer detail, try to
      bypass by selecting Government ID (front) before it disappears,
      then submit. Server returns **409 Conflict** with the existing
      record + the UI toast says "A submission for this document type
      is already on file. Resubmit only after the existing one is
      rejected."
- [ ] Pick **Selfie holding ID**. Capture mode is `user` (front-facing
      lens). Verify the front camera opens.
- [ ] Pick **Proof of income** (PDF use case). The capture button is
      hidden — just a plain "Choose file" upload (no camera mode for
      typed docs).
- [ ] Mark the ID_FRONT submission **REJECTED** via the KYC review UI.
      Return to the customer detail page. Verify ID_FRONT is now
      re-selectable in the dropdown (REJECTED docs allow resubmit).

## 5. DORSI tag with CustomerPicker

- [ ] Open **/compliance/dorsi → "Tag customer"**.
- [ ] Confirm the field is a **search picker** (not a UUID input). Type
      a partial name / CUST-… / government ID number → suggestions
      show. The hint reads "Start typing to find an existing customer
      record."
- [ ] Pick a customer → category Officer, basis "Smoke test" → submit.
      Returns 201.
- [ ] On the Register table, the new row's "Customer" cell shows the
      customer name _and_ the CUST-… number directly underneath. The
      name links to `/customers/CUST-…` (not the UUID).
- [ ] On the Utilization table (if the customer has active loans), the
      per-borrower row uses the CUST-… URL too.
- [ ] **Re-tag**: tag the same customer again with category Director +
      different basis. The existing record updates (upsert semantics);
      not a new row.

## 6. Customer ledger + statement of account

- [ ] On any customer with at least one loan: open the **Statement** /
      ledger panel.
- [ ] Click **PDF** → downloads `statement-CUST-….pdf`. Open in a PDF
      reader; verify the company name from `/settings → Branding`
      appears on page 1 and the running balance column ticks correctly.
- [ ] Click **CSV** → downloads `statement-CUST-….csv`. Opens cleanly
      in Excel/Sheets with the comment-block header + running balance.
- [ ] Click **Email the statement** → 202 response.
  - [ ] If the customer has an email on file: notification bell shows
        a new STATEMENT_READY entry; mock email provider logs to API
        console.
  - [ ] If the customer has no email: 202 returns with `sentTo: null`
        and message "Customer has no email on file — in-app
        notification logged."

---

## Known caveats to watch for

- **Self-signed cert in dev** — getUserMedia requires HTTPS or
  localhost. If the dev server runs on a non-localhost hostname, the
  camera button silently does nothing; check the JS console for
  `NotAllowedError: Only secure contexts may call getUserMedia`.
- **PSGC starter data is partial** — only 60 cities + ~75 barangays
  are bundled. Anything not in the list still saves but won't appear
  in suggestions. The full PSA dataset ingestion is tracked
  separately (see PSGC ingestion task).
- **Old customers without email** — existing seeded records may lack
  an email. The PATCH endpoint accepts partial updates so editing them
  still works, but POST now requires it. If you can't open the Edit
  dialog on a legacy customer, check the browser console for a 400 +
  `path: ["email"]` and fill the field before saving.

## When something breaks

Paste the request/response (Network tab) + the API server log lines
into the next session prompt. The API logger redacts sensitive paths
(password / token / governmentIdNumber) so it's safe to share.
