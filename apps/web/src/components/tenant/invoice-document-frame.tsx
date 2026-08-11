'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The invoice, on screen, exactly as it prints.
 *
 * ⚠️ IT IS AN IFRAME, AND THE IFRAME IS THE FEATURE RATHER THAN A COMPROMISE.
 *   The requirement is that what a clinic sees here and what a patient receives
 *   as a PDF are the same document. That holds because both are
 *   `renderInvoiceHtml(data)` — the same function, over the same
 *   `InvoiceDocumentData` the API returns, producing one HTML string. Rendering
 *   `<InvoiceDocument />` into this app's own DOM instead would put the document
 *   under `globals.css`, Tailwind's preflight and whatever a parent screen
 *   sets — so the preview would be styled by the app and the PDF would not, and
 *   the difference would show up as a layout somebody has to reconcile by eye.
 *
 *   The frame gives the document its own document, its own cascade and its own
 *   `@page` box. Nothing leaks in; nothing leaks out.
 *
 * ⚠️ `src` AND NOT `srcDoc`, AND THE BUILD IS WHAT DECIDED THAT. This component
 *   was written in Phase 6 to take the finished HTML as a prop, rendered by a
 *   Server Component — and it was imported by nothing until Phase 9. The first
 *   page to import it failed `next build`: `renderInvoiceHtml` reaches
 *   `react-dom/server`, which Next refuses in a Server Component's module graph.
 *   Typecheck had been clean throughout, which is the whole reason this repo's
 *   working agreements say to run the thing.
 *
 *   So the render moved one step out, into the `preview` Route Handler beside the
 *   invoice page, and the frame loads it. Everything Phase 6 wanted survives: one
 *   render function shared with the worker, the document in a document of its own,
 *   and ~140KB of inlined typefaces never shipped to a browser that did not open
 *   the invoice.
 *
 * ⚠️ AND IT IS SANDBOXED, WHICH COSTS NOTHING BECAUSE THE DOCUMENT HAS NO
 *   SCRIPTS. `sandbox` with no `allow-scripts` means the frame cannot run
 *   JavaScript, navigate the parent, or submit a form. The template test already
 *   asserts there is no `<script>` in the output; this is the belt to that
 *   braces, and it is the reason a template that one day interpolated something
 *   unescaped could not turn into an XSS against the clinic's session. The handler
 *   sends a `Content-Security-Policy` saying the same thing a third time.
 *
 * ⚠️ THE FRAME IS SCALED TO FIT, AND THE DOCUMENT INSIDE IT IS NOT TOUCHED.
 *   A sheet is 210mm wide — about 794 CSS pixels — and the column it sits in is
 *   narrower than that on most screens, so the frame used to show the top-left
 *   corner of an A4 page with two scrollbars. It read as "zoomed in", which is
 *   exactly what it was.
 *
 *   The fix is a CSS transform on the FRAME: the iframe keeps its true 794px
 *   width and the whole box is scaled down to whatever the column allows. The
 *   alternative — a screen-only stylesheet that reflows the sheet narrower —
 *   would make the preview and the print two different layouts, which is the one
 *   thing this component exists to prevent. Scaling changes the size of the
 *   picture and nothing about the document.
 *
 *   It needs the container's width, which only the browser knows, so this is a
 *   client component with a `ResizeObserver`. Never scaled ABOVE 1: an invoice
 *   blown up past life size on a wide monitor looks like a rendering error.
 */

/** 210mm and 297mm at the CSS reference 96dpi, which is what the sheet is. */
const A4_WIDTH_PX = 794;
const A4_HEIGHT_PX = 1123;

export interface InvoiceDocumentFrameProps {
  /**
   * Where the rendered document is served from — the `preview` Route Handler.
   *
   * A tenant-relative path (`/invoices/<id>/preview`), like every other link
   * inside a clinic: `proxy.ts` rewrites the host into the `/t/<slug>` segment on
   * the way in, so writing that segment here would have it rewritten twice and
   * 404. See apps/web/AGENTS.md.
   */
  src: string;
  /** For the frame's accessible name. Null while the invoice is a draft. */
  invoiceNumber: string | null;
  /**
   * How much of the document to show before it scrolls, in unscaled pixels.
   *
   * ⚠️ AN IFRAME CANNOT SIZE ITSELF TO ITS CONTENT WITHOUT SCRIPTS, and the
   *   sandbox above is why it has none. So the frame is given a height. Exactly
   *   one A4 page is the right default — the stylesheet puts no padding around
   *   the sheet on screen — so a one-page bill, which is nearly all of them,
   *   shows whole with no scrolling at all, and a longer one scrolls inside the
   *   frame the way a document does.
   */
  pageHeightPx?: number;
  className?: string;
}

export function InvoiceDocumentFrame({
  src,
  invoiceNumber,
  pageHeightPx = A4_HEIGHT_PX,
  className,
}: InvoiceDocumentFrameProps) {
  const holder = useRef<HTMLDivElement>(null);
  /*
   * Starts at 1 and is corrected on mount. The wrapper clips, so the first paint
   * shows the document's top-left rather than bursting out of the column.
   */
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const node = holder.current;
    if (!node) return;

    const measure = (width: number): void => {
      if (width > 0) setScale(Math.min(1, width / A4_WIDTH_PX));
    };

    measure(node.clientWidth);

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) measure(width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={holder}
      className={className ?? 'border-rule bg-card w-full overflow-hidden rounded-md border'}
      /*
       * The scaled height, so the box ends where the picture does. Without it the
       * container keeps the unscaled height and leaves a band of empty card
       * below the document.
       */
      style={{ height: `${String(Math.round(pageHeightPx * scale))}px` }}
    >
      <iframe
        src={src}
        /*
         * The document titles itself with the invoice number and never the
         * patient — see `renderInvoiceHtml`. This is the same rule for the frame,
         * which is what a screen reader announces.
         */
        title={
          invoiceNumber === null ? 'Draft invoice preview' : `Invoice ${invoiceNumber} preview`
        }
        sandbox=""
        loading="lazy"
        className="border-0"
        style={{
          width: `${String(A4_WIDTH_PX)}px`,
          height: `${String(pageHeightPx)}px`,
          transform: `scale(${String(scale)})`,
          transformOrigin: 'top left',
        }}
      />
    </div>
  );
}
