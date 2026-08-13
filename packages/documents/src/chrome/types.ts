/**
 * The header and footer every printed document in rcln carries.
 *
 * ⚠️ THIS TYPE IS DELIBERATELY NOT `InvoiceDocumentIssuer`, THOUGH IT IS THE
 *   SAME SHAPE TODAY. An invoice's issuer is a snapshot of who RAISED A BILL,
 *   and it carries a registration number because that is what the tax is
 *   remitted against. A prescription's header is who WROTE IT, a lab report's is
 *   who RAN IT, and neither is a billing party. Making every future template
 *   import the invoice's type would make the invoice the definition of a clinic,
 *   and the first document that needed a field the invoice does not have would
 *   either add it there — where it means nothing — or start a second header.
 *
 * What every document genuinely shares is: whose premises this came from, what
 * the document is called, and the two or three facts that identify this
 * particular one. That is all this holds.
 */

/** The clinic, hospital or branch the document came from. */
export interface DocumentChromeIssuer {
  /** The registered legal name. */
  legalName: string;
  /** The name over the door, when it differs. */
  tradeName: string | null;
  branchName: string;
  branchCode: string;
  addressLines: readonly string[];
  phone: string | null;
  email: string | null;
  /**
   * A registration number, where the document type has one.
   *
   * ⚠️ NULL PRINTS NOTHING AT ALL, NOT AN EMPTY LABEL. A bare "GSTIN:" with no
   *   number reads as a data-entry omission; a clinic below the registration
   *   threshold has a legal position, not a missing field.
   */
  taxId: string | null;
  /** What that number is called here. Only meaningful when `taxId` is set. */
  taxIdLabel: string;
}

/** One `label: value` line in the top-right identification block. */
export interface DocumentChromeMetaRow {
  label: string;
  value: string;
  /**
   * Set the value in mono. For anything the system generated rather than a
   * person wrote — a document number, an MRN — per the design system.
   */
  mono?: boolean;
}

/**
 * Everything the repeating chrome needs, and nothing a body needs.
 *
 * ⚠️ NO PHI IN HERE, ON ANY DOCUMENT TYPE. This block repeats on every page,
 *   including pages a clinic may photocopy, fax or hand to somebody who is not
 *   the patient. A patient's name belongs in the body of the document that is
 *   about them, once, where the reader expects it — not stamped down the side of
 *   every sheet. A prescription's header names the PRESCRIBER and the clinic.
 */
export interface DocumentChrome {
  issuer: DocumentChromeIssuer;
  /** "Tax Invoice", "Prescription", "Laboratory Report". */
  title: string;
  /** Document number, dates — the two or three facts that identify this one. */
  meta: readonly DocumentChromeMetaRow[];
  /**
   * The small print along the foot, beside the page number.
   *
   * ⚠️ ON AN INDIAN INVOICE THIS IS A CLAIM RATHER THAN BOILERPLATE — an
   *   unsigned invoice is acceptable precisely when it says it is computer
   *   generated, and one that does not say so is one a recipient may reject. It
   *   is per-document for that reason and is not a constant in here.
   */
  footerNote: string | null;
}
