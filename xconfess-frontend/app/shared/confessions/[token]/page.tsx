import { notFound } from "next/navigation";
import { resolveBackendRoute } from "@/app/lib/api/proxy";

export default async function ScopedConfessionPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const request = new Request(`http://localhost/shared/confessions/${token}`);
  const backend = resolveBackendRoute(
    request,
    `/confessions/shared/${encodeURIComponent(token)}`,
  );
  const response = await fetch(backend.url, { cache: "no-store" });

  if (!response.ok) notFound();

  const confession = await response.json();

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <article className="luxury-panel rounded-2xl p-6">
        <p className="text-xs uppercase tracking-[0.16em] text-[var(--secondary)]">
          Scoped confession link
        </p>
        <p className="mt-4 whitespace-pre-wrap font-editorial text-[1.35rem] leading-[1.42]">
          {confession.message}
        </p>
      </article>
    </main>
  );
}
