/**
 * Super-admin console, served from admin.<root-domain>.
 * Deliberately a separate route tree: different auth path, different risk
 * profile, and it must never share a bundle with the tenant app.
 */
export default function PlatformHome() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-4 p-8">
      <p className="text-sm uppercase tracking-widest text-neutral-500">Platform</p>
      <h1 className="text-4xl font-semibold tracking-tight">Super admin console</h1>
      <p className="text-neutral-600 dark:text-neutral-400">
        Requires <code>users.is_platform_admin</code>. Every tenant entry from here is audited.
      </p>
    </main>
  );
}
