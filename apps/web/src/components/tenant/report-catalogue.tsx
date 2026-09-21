import Link from 'next/link';
import type { ReportCatalogue } from '@rcln/contracts';

/**
 * The menu of reports, and what the caller may do with each.
 *
 * ⚠️ THE SERVER DECIDED `available`, AND THIS COMPONENT DOES NOT SECOND-GUESS IT.
 *   Filtering a hard-coded list against the session's permission array here
 *   would be right until the first custom role — a clinic that clones ACCOUNTANT
 *   and removes one code would still see the tile, click it, and land on a 403
 *   with nothing to read. `GET /api/v1/reports` resolves it where the
 *   permissions actually live.
 *
 * ⚠️ AN UNAVAILABLE REPORT IS SHOWN AND NAMED, NOT HIDDEN, WHICH IS A DELIBERATE
 *   DEPARTURE FROM HOW THE NAVIGATION BEHAVES. A tab nobody may open is noise;
 *   a report nobody may open is a thing somebody has to go and ASK for, and
 *   hiding it turns "who do I ask, and for what" into a support ticket. The
 *   permission code is printed because it is what an administrator types.
 *
 * NO PHI. Nothing on this screen or behind it names a patient.
 */
export function ReportCatalogueList({ catalogue }: { catalogue: ReportCatalogue }) {
  const available = catalogue.reports.filter((report) => report.available);
  const locked = catalogue.reports.filter((report) => !report.available);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Reports
        </h1>
        <p className="text-muted mt-1 max-w-2xl text-[0.875rem]">
          What the stock, the counter and the procedures add up to. Every figure is read from the
          ledger when you open it — nothing here is stored or cached.
        </p>
      </header>

      {available.length === 0 ? (
        <div className="border-rule bg-card rounded-md border p-10 text-center">
          <p className="text-ink text-[0.9375rem]">You cannot open any report here yet.</p>
          <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
            Ask an administrator at this clinic for one of the permissions listed below.
          </p>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {available.map((report) => (
            <li key={report.key}>
              <Link
                href={`/reports/${report.key}`}
                className="border-rule bg-card hover:border-drape focus-visible:outline-signal block h-full rounded-md border p-5 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <span className="text-ink block text-[0.9375rem] font-medium">{report.title}</span>
                <span className="text-muted mt-1.5 block text-[0.875rem]">{report.summary}</span>
                <span className="text-muted mt-3 block font-mono text-[0.75rem]">
                  {report.dated ? 'over a period' : 'as it stands now'}
                  {report.exportable ? ' · exportable' : ''}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {locked.length > 0 ? (
        <section>
          <h2 className="text-ink text-[0.9375rem] font-medium">Not available to you</h2>
          <p className="text-muted mt-1 text-[0.875rem]">
            These exist at this clinic. Each needs the permission named beside it.
          </p>
          <ul className="border-rule divide-rule bg-card mt-3 divide-y rounded-md border">
            {locked.map((report) => (
              <li key={report.key} className="flex flex-wrap items-baseline gap-x-3 px-4 py-3">
                <span className="text-muted text-[0.9375rem]">{report.title}</span>
                <span className="text-muted ml-auto font-mono text-[0.75rem]">
                  {report.permission}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
