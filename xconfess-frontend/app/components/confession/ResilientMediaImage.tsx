"use client";

import { useState } from "react";
import Image from "next/image";

interface ResilientMediaImageProps {
  src: string;
  alt: string;
  sizes: string;
  aspectRatio?: number | null;
}

export function ResilientMediaImage({
  src,
  alt,
  sizes,
  aspectRatio,
}: ResilientMediaImageProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const stableAspectRatio =
    typeof aspectRatio === "number" && Number.isFinite(aspectRatio) && aspectRatio > 0
      ? aspectRatio
      : 16 / 9;

  return (
    <div
      className="relative my-3 w-full overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]"
      style={{ aspectRatio: stableAspectRatio }}
      data-testid="media-geometry-box"
    >
      {failedSrc === src ? (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[var(--surface-muted)] p-4 text-center text-sm text-[var(--secondary)]"
          aria-live="polite"
        >
          <p>Image unavailable: {alt}</p>
          <button
            type="button"
            onClick={() => {
              setFailedSrc(null);
              setRetryCount((count) => count + 1);
            }}
            className="rounded-lg border border-[var(--border)] px-3 py-2 font-semibold text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
          >
            Retry image
          </button>
        </div>
      ) : (
        <Image
          key={`${src}-${retryCount}`}
          src={src}
          alt={alt}
          fill
          sizes={sizes}
          className="object-cover transition-opacity duration-200"
          loading="lazy"
          onError={() => setFailedSrc(src)}
        />
      )}
    </div>
  );
}
