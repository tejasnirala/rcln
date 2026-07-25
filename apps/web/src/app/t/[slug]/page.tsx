/**
 * Tenant landing route. Reached only via the proxy rewrite in src/proxy.ts:
 * alpha.lvh.me:3000/ -> /t/alpha
 */
export default async function TenantHome({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-4 p-8">
      <p className="text-sm uppercase tracking-widest text-neutral-500">Tenant resolved</p>
      <h1 className="text-4xl font-semibold tracking-tight">{slug}</h1>
      <p className="text-neutral-600 dark:text-neutral-400">
        The subdomain was mapped to this organization by <code>src/proxy.ts</code>. Phase 1 replaces
        this with the login screen and the branch switcher.
      </p>
    </main>
  );
}
