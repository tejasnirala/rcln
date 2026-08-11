-- ===========================================================================
-- Phase 5 — the invoice lifecycle, enforced by Postgres rather than by habit.
--
-- Phase 3 shipped `InvoiceStatus` and said so plainly in the model comment:
-- "NOTHING ENFORCES IMMUTABILITY YET. The status column is a convention until
-- Phase 5's database-level guard lands." This is that guard.
--
-- ⚠️ WHY THE DATABASE AND NOT THE SERVICE.
--   An issued invoice is a document a patient has been handed and may have
--   claimed against insurance. The service layer is one of several ways a row
--   gets written — a fix-up script, a future worker, a `prisma studio` session,
--   the next endpoint somebody adds in a hurry — and a rule that lives in one
--   function is a rule the other four paths do not have. Nothing about
--   rewriting `grand_total` on an ISSUED invoice fails loudly today: the row
--   updates, the PDF on disk keeps saying the old number, and the two disagree
--   for ever. There is no error to notice, which is precisely why the
--   constraint has to be somewhere every path goes through.
--
-- ⚠️ THREE GUARDS, NOT ONE, BECAUSE THEY REFUSE THREE DIFFERENT MISTAKES.
--   1. `invoices_lifecycle_guard`  — an illegal transition, and any edit to the
--      document's own figures once it has left DRAFT.
--   2. `invoices_no_delete_after_issue` — a numbered invoice DELETEd out of the
--      series, leaving a gap somebody has to explain to an auditor.
--   3. `invoice_children_follow_parent` — a line or a tax row added, edited or
--      removed under an invoice that is already a document. The parent's totals
--      being frozen means nothing if its lines can still move: the invoice
--      would then state a total that is not the sum of what it prints, which is
--      the first internal contradiction an auditor checks for.
--
-- ⚠️ THE OWNER IS EXEMPT, EXACTLY AS IT IS UNDER RLS ENABLE (ADR-0003).
--   `rcln_owner` is what migrations, seeds, `ON DELETE CASCADE` from
--   `organizations` and the integration suites' cleanup all run as. The app
--   connects as `rcln_app` and is the thing being constrained. This is the same
--   shape as `audit_logs`, `data_access_logs` and `appointment_status_history`,
--   and it is deliberate that it is a TRIGGER rather than a RULE — see the
--   20260807093000_appointment_status_history_immutability migration for what a
--   rule does to a cascade, and why it fails silently in the ordinary case.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Transitions, and immutability from ISSUED onwards.
--
-- ⚠️ THE FROZEN SET IS AN ALLOW-LIST OF WHAT MAY STILL MOVE, NOT A DENY-LIST OF
--   WHAT MAY NOT. A deny-list is a list that a later migration adds a column
--   beside, and the new column is then silently mutable on an issued document
--   with nothing in this file mentioning it. Stated the other way round, a
--   column added tomorrow is frozen by default and somebody has to come here
--   and argue for it. That is the same failure `roles.ts` guards against by
--   naming the clinical authoring codes explicitly — "everything except" is a
--   definition that grows in the wrong direction.
--
--   What stays mutable, and why each one has to:
--     status              — the transitions below are the point of the trigger
--     amount_paid         — how ISSUED reaches PARTIALLY_PAID and PAID. It is
--                           settlement AGAINST the document, not a restatement
--                           of it: the balance is `grand_total − amount_paid`
--                           and only the second term moves.
--     cancelled_by/_at, voided_at, cancellation_reason
--                         — written BY the cancel and void transitions
--     updated_at          — Prisma writes it on every update
--
--   `deleted_at` is deliberately NOT here. Soft delete is for a DRAFT; an
--   issued invoice is VOIDed, which keeps the number and the trail.
--
-- ⚠️ `DRAFT` AND `FINALIZING` ARE BOTH OPEN, AND THAT IS WHAT MAKES
--   FINALISATION EXPRESSIBLE AT ALL. Finalisation is two updates in one
--   transaction: DRAFT -> FINALIZING writes the number, the issue date and
--   every computed total; FINALIZING -> ISSUED changes nothing but the status.
--   The guard reads OLD.status, so both writes land while the row is still
--   open and the freeze begins the instant it is not.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION invoices_lifecycle_guard() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE
  -- Every other column of `invoices` is frozen from ISSUED onwards.
  mutable_after_issue CONSTANT text[] := ARRAY[
    'status',
    'amount_paid',
    'cancelled_by',
    'cancelled_at',
    'voided_at',
    'cancellation_reason',
    'updated_at'
  ];
  changed text;
BEGIN
  -- The table's own owner passes, exactly as it does under RLS ENABLE.
  IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID) = current_user THEN
    RETURN NEW;
  END IF;

  -- The transition table. Anything not named here is refused, including the
  -- ones that look harmless: ISSUED -> DRAFT would un-issue a document that has
  -- been printed, and CANCELLED -> anything would revive a bill whose serial
  -- was never taken.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'DRAFT'          AND NEW.status IN ('FINALIZING', 'CANCELLED'))
      OR (OLD.status = 'FINALIZING'     AND NEW.status = 'ISSUED')
      OR (OLD.status = 'ISSUED'         AND NEW.status IN ('PARTIALLY_PAID', 'PAID', 'VOID'))
      OR (OLD.status = 'PARTIALLY_PAID' AND NEW.status IN ('PAID', 'VOID'))
      OR (OLD.status = 'PAID'           AND NEW.status = 'VOID')
    ) THEN
      RAISE EXCEPTION 'invoice % cannot move from % to %', OLD.id, OLD.status, NEW.status
        USING HINT = 'DRAFT->FINALIZING->ISSUED->PARTIALLY_PAID/PAID, VOID from any issued state, CANCELLED from DRAFT only. CANCELLED and VOID are terminal.';
    END IF;
  END IF;

  -- Still being assembled, or mid-finalisation. Everything may move.
  IF OLD.status IN ('DRAFT', 'FINALIZING') THEN
    RETURN NEW;
  END IF;

  -- Compared as jsonb rather than column by column so that a column added by a
  -- later migration is covered without this function being edited.
  SELECT string_agg(o.key, ', ' ORDER BY o.key) INTO changed
    FROM jsonb_each(to_jsonb(OLD)) AS o
   WHERE NOT (o.key = ANY (mutable_after_issue))
     AND o.value IS DISTINCT FROM (to_jsonb(NEW) -> o.key);

  IF changed IS NOT NULL THEN
    RAISE EXCEPTION 'invoice % is % and its document may not change: %', OLD.id, OLD.status, changed
      USING HINT = 'Correct an issued invoice with a credit note and a new invoice, never by editing this one.';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS invoices_lifecycle_guard ON invoices;
CREATE TRIGGER invoices_lifecycle_guard
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_lifecycle_guard();

-- ---------------------------------------------------------------------------
-- 2. A numbered invoice is never deleted.
--
-- ⚠️ THIS IS ABOUT THE SERIES, NOT ABOUT THE ROW. GST requires a serial that is
--   consecutive; a DELETE takes a number out of the middle of one and leaves a
--   hole that no later reprint can fill, because `issueNumber()` will never
--   hand that number out again. VOID exists precisely so a document can be
--   undone while its number stays where it was.
--
--   DRAFT and CANCELLED are deletable because neither has ever held a number —
--   `invoices_number_matches_status` is what makes that a fact rather than an
--   assumption.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION invoices_no_delete_after_issue() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID) = current_user THEN
    RETURN OLD;
  END IF;

  IF OLD.status IN ('DRAFT', 'CANCELLED') THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'invoice % is % and carries number %: it cannot be deleted', OLD.id, OLD.status, OLD.invoice_number
    USING HINT = 'Void it. A deleted number is a permanent gap in a series somebody has to explain.';
END
$$;

DROP TRIGGER IF EXISTS invoices_no_delete_after_issue ON invoices;
CREATE TRIGGER invoices_no_delete_after_issue
  BEFORE DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_no_delete_after_issue();

-- ---------------------------------------------------------------------------
-- 3. Lines and tax rows are frozen with the invoice that prints them.
--
-- ⚠️ WITHOUT THIS, GUARD 1 PROTECTS A NUMBER AND NOT A DOCUMENT. `grand_total`
--   being immutable is worth nothing while a line can be inserted underneath
--   it: the invoice then states a total that is not the sum of what it prints,
--   and the patient's copy and the clinic's copy disagree about a bill neither
--   of them changed.
--
-- ⚠️ AN INVISIBLE PARENT IS ALLOWED THROUGH, AND THAT IS NOT A HOLE.
--   Two cases reach it. A cascade from the parent's own DELETE, where the
--   parent row is already gone by the time the child trigger fires and guard 2
--   has already had its say about whether that DELETE was permitted at all. And
--   a write citing an invoice this tenant or this branch cannot see, which RLS'
--   own WITH CHECK refuses a moment later on the child row itself. In neither
--   case is there a document for this trigger to protect.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION invoice_is_open(p_organization_id uuid, p_invoice_id uuid)
  RETURNS boolean LANGUAGE sql STABLE AS
$$
  SELECT COALESCE(
    (SELECT i.status IN ('DRAFT', 'FINALIZING')
       FROM invoices i
      WHERE i.organization_id = p_organization_id
        AND i.id = p_invoice_id),
    true)
$$;

CREATE OR REPLACE FUNCTION invoice_children_follow_parent() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID) = current_user THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Both sides are checked on an UPDATE: moving a line onto an issued invoice
  -- and moving one off it are two different ways to change a printed document.
  IF TG_OP <> 'INSERT' AND NOT invoice_is_open(OLD.organization_id, OLD.invoice_id) THEN
    RAISE EXCEPTION '% on % is refused: invoice % is already issued', TG_OP, TG_TABLE_NAME, OLD.invoice_id
      USING HINT = 'An issued invoice''s lines are the document. Raise a credit note and a new invoice.';
  END IF;

  IF TG_OP <> 'DELETE' AND NOT invoice_is_open(NEW.organization_id, NEW.invoice_id) THEN
    RAISE EXCEPTION '% on % is refused: invoice % is already issued', TG_OP, TG_TABLE_NAME, NEW.invoice_id
      USING HINT = 'An issued invoice''s lines are the document. Raise a credit note and a new invoice.';
  END IF;

  RETURN COALESCE(NEW, OLD);
END
$$;

DROP TRIGGER IF EXISTS invoice_items_follow_parent ON invoice_items;
CREATE TRIGGER invoice_items_follow_parent
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_items
  FOR EACH ROW EXECUTE FUNCTION invoice_children_follow_parent();

DROP TRIGGER IF EXISTS invoice_taxes_follow_parent ON invoice_taxes;
CREATE TRIGGER invoice_taxes_follow_parent
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_taxes
  FOR EACH ROW EXECUTE FUNCTION invoice_children_follow_parent();

-- `invoice_documents` is deliberately NOT guarded. Its rows are written AFTER
-- the invoice is issued — that is when the PDF is rendered (Phase 6) — and a
-- FAILED render is retried by superseding the row. The document is not the
-- invoice; `invoice_documents_current_per_type_key` is what keeps it honest.
