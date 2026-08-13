/**
 * The header and footer, as markup. Every document type renders these two.
 *
 * ⚠️ THESE ARE ORDINARY FLOW ELEMENTS AND THEIR SOURCE ORDER IS THE PREVIEW'S
 *   LAYOUT. The header goes first in the sheet and the footer goes LAST, after
 *   the body — they are not a pair to be declared together. They were, while the
 *   chrome was `position: fixed` and position in the source did not matter; once
 *   print moved to Chromium's templates and these became the preview's own
 *   markup, a footer declared beside the header rendered above the invoice on
 *   every screen. The PDF stayed correct throughout, which is exactly why it
 *   survived review.
 *
 * ⚠️ IN PRINT NEITHER OF THESE IS SHOWN AT ALL. `chrome/styles.ts` hides them
 *   and Chromium repeats the `template.tsx` copies instead. Styling only what
 *   you see on screen and expecting the PDF to follow is the trap here.
 *
 * See `chrome/types.ts` for why this data is not the invoice's issuer type.
 */

import type { JSX } from 'react';

import type { DocumentChrome } from './types.js';

/**
 * Who and what, repeated on every page.
 *
 * ⚠️ THE BAND IS A FIXED HEIGHT AND THIS MARKUP HAS TO FIT IN IT. `styles.ts`
 *   clips the overflow rather than letting the band grow, because a header that
 *   is 26mm on page one and 31mm on page two moves every row of the table below
 *   it. A clinic with a very long address loses its last line — which is the
 *   right trade against a document whose layout changes between sheets, and it
 *   is why the address is the LAST thing in the block rather than the first.
 */
export function PageHeader({ chrome }: { chrome: DocumentChrome }): JSX.Element {
  const { issuer } = chrome;

  return (
    <header className="page-header">
      {/*
       * ⚠️ THE RULE IS ON THIS INNER BOX, NOT ON THE BAND, AND THE DIFFERENCE IS
       *   VISIBLE ON EVERY SHORT HEADER. The band is a FIXED height so the body
       *   starts in the same place on every page; hanging the rule off the band
       *   put it at the bottom of that fixed height, so a clinic with a
       *   three-line header got a wide empty gap between its address and the
       *   line under it. On this box the rule hugs whatever the header actually
       *   is, and the leftover height becomes air above the body instead.
       */}
      <div className="page-header-inner">
        <div>
          <div className="chrome-issuer-name">{issuer.legalName}</div>
          {issuer.tradeName === null ? null : (
            <div className="chrome-issuer-trade">{issuer.tradeName}</div>
          )}

          {/*
           * ⚠️ JOINED WITH A SEPARATOR, NOT WITH NEWLINES, AND THE BAND'S HEIGHT
           *   DEPENDS ON IT. The block is set to WRAP inside a column over 100mm
           *   wide, so a five-line hospital address becomes two or three lines
           *   rather than five. Restoring the newline join brings back the defect
           *   where the tail of a long address disappeared under the rule that
           *   closes the header.
           */}
          <div className="chrome-issuer-detail">
            {[issuer.branchName, ...issuer.addressLines].filter(Boolean).join(' · ')}
          </div>

          {/*
           * Joined with a separator rather than laid out, because either half may
           * be absent and an empty cell would leave a gap that reads as a missing
           * value rather than as a clinic that publishes no email address.
           */}
          {issuer.phone === null && issuer.email === null ? null : (
            <div className="chrome-issuer-detail">
              {[issuer.phone, issuer.email].filter(Boolean).join('  ·  ')}
            </div>
          )}

          {issuer.taxId === null ? null : (
            <div className="chrome-issuer-tax">
              <span className="label">{issuer.taxIdLabel}</span>{' '}
              <span className="mono strong">{issuer.taxId}</span>
            </div>
          )}
        </div>

        <div className="chrome-doc">
          <div className="chrome-doc-title">{chrome.title}</div>

          {chrome.meta.length === 0 ? null : (
            <dl className="chrome-doc-meta">
              {chrome.meta.map((row) => (
                /*
                 * ⚠️ KEYED ON THE LABEL, WHICH IS UNIQUE BY CONSTRUCTION — a
                 *   document with two rows both called "Date" is a bug in the
                 *   caller, not something to paper over with an index key. There
                 *   is no reconciliation here anyway (`renderToStaticMarkup`), so
                 *   this is for the linter and for the reader.
                 */
                <div key={row.label} style={{ display: 'contents' }}>
                  <dt>{row.label}</dt>
                  <dd className={row.mono === true ? 'mono' : undefined}>{row.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
    </header>
  );
}

/**
 * The rule along the foot, the document's small print, and — when printing —
 * the page count.
 *
 * ⚠️ `children` IS THE PAGE COUNTER AND IS PASSED ONLY BY `template.tsx`. The
 *   count comes from Chromium substituting into `<span class="totalPages">`,
 *   which it does ONLY inside a print footer template. The same component
 *   rendered into the document for the on-screen preview is given no children,
 *   because on screen there is one continuous sheet: no second page to be on and
 *   no total to count. An empty "Page of" in the preview would look like a bug.
 */
export function PageFooter({
  chrome,
  children,
}: {
  chrome: DocumentChrome;
  children?: JSX.Element;
}): JSX.Element {
  return (
    <footer className="page-footer">
      <span>{chrome.footerNote ?? ''}</span>
      {children ?? null}
    </footer>
  );
}
