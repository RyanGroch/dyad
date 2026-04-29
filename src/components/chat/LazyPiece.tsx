import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

// TEMP DEBUG: aggressive thresholds to test DOM-cost hypothesis.
// Originals: LAZY_THRESHOLD=2000, ROOT_MARGIN="1500px ...", UNMOUNT_DELAY_MS=1500.
const LAZY_THRESHOLD = 2;
const ROOT_MARGIN = "100px 0px 0px 0px";
const UNMOUNT_DELAY_MS = 2000;

const heightCache = new Map<string, number>();

// TEMP DEBUG: registry of every LazyPiece currently in the tree.
// Drives `window.__dyadLazyDump()` so we can verify mount/unmount behavior.
type LazyDebugEntry = {
  label: string;
  sizeHint: number;
  pinned: boolean;
  shouldLazy: boolean;
  mounted: boolean;
};
const lazyDebugRegistry = new Map<string, LazyDebugEntry>();

if (typeof window !== "undefined") {
  (window as any).__dyadLazyDump = () => {
    const rows = Array.from(lazyDebugRegistry.entries()).map(([key, e]) => ({
      key,
      label: e.label,
      sizeHint: e.sizeHint,
      pinned: e.pinned,
      shouldLazy: e.shouldLazy,
      mounted: e.mounted,
    }));
    const total = rows.length;
    const mounted = rows.filter((r) => r.mounted).length;
    const unmounted = rows.filter((r) => !r.mounted).length;
    const lazyCount = rows.filter((r) => r.shouldLazy).length;
    // eslint-disable-next-line no-console
    console.log(
      `[LazyPiece] total=${total} mounted=${mounted} unmounted=${unmounted} lazyEligible=${lazyCount} bypassed=${total - lazyCount}`,
    );
    // eslint-disable-next-line no-console
    console.table(rows);
    return { total, mounted, unmounted, lazyEligible: lazyCount, rows };
  };
}

function findScrollParent(el: HTMLElement | null): Element | null {
  let cur: HTMLElement | null = el?.parentElement ?? null;
  while (cur) {
    const style = window.getComputedStyle(cur);
    if (/(auto|scroll|overlay)/.test(style.overflowY)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

interface LazyPieceProps {
  children: React.ReactNode;
  pinned: boolean;
  sizeHint: number;
  cacheKey: string;
  disabled?: boolean;
  /** TEMP DEBUG label, e.g. "markdown[42]: Hello world..." */
  debugLabel?: string;
}

export function LazyPiece({
  children,
  pinned,
  sizeHint,
  cacheKey,
  disabled,
  debugLabel,
}: LazyPieceProps) {
  const shouldLazy = !disabled && !pinned && sizeHint >= LAZY_THRESHOLD;
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const unmountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mounted, setMounted] = useState(!shouldLazy);
  const [cachedHeight, setCachedHeight] = useState<number | undefined>(() =>
    heightCache.get(cacheKey),
  );

  // TEMP DEBUG: keep registry in sync.
  useEffect(() => {
    lazyDebugRegistry.set(cacheKey, {
      label: debugLabel ?? "(unlabeled)",
      sizeHint,
      pinned,
      shouldLazy,
      mounted,
    });
    return () => {
      lazyDebugRegistry.delete(cacheKey);
    };
  }, [cacheKey, debugLabel, sizeHint, pinned, shouldLazy, mounted]);

  // TEMP DEBUG: log mount/unmount transitions.
  const prevMountedRef = useRef(mounted);
  useEffect(() => {
    if (prevMountedRef.current !== mounted) {
      // eslint-disable-next-line no-console
      console.log(
        `[LazyPiece] ${mounted ? "MOUNT  " : "UNMOUNT"} key=${cacheKey} size=${sizeHint} pinned=${pinned} :: ${debugLabel ?? ""}`,
      );
      prevMountedRef.current = mounted;
    }
  }, [mounted, cacheKey, sizeHint, pinned, debugLabel]);

  // Re-evaluate mount state when shouldLazy flips (e.g. piece becomes pinned).
  useEffect(() => {
    if (!shouldLazy) {
      setMounted(true);
      if (unmountTimerRef.current) {
        clearTimeout(unmountTimerRef.current);
        unmountTimerRef.current = null;
      }
    }
  }, [shouldLazy]);

  useEffect(() => {
    if (!shouldLazy) return;
    const target = placeholderRef.current;
    if (!target) return;
    const root = findScrollParent(target);
    // TEMP DEBUG: log which scroller the observer attached to.
    // eslint-disable-next-line no-console
    console.log(
      `[LazyPiece] observer attached key=${cacheKey} root=`,
      root,
      `rootTag=${root ? (root as HTMLElement).tagName : "VIEWPORT"}`,
      `rootClass=${root ? (root as HTMLElement).className : ""}`,
    );
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          // eslint-disable-next-line no-console
          console.log(
            `[LazyPiece] entry key=${cacheKey} intersecting=${entry.isIntersecting} ratio=${entry.intersectionRatio.toFixed(2)}`,
          );
          if (entry.isIntersecting) {
            if (unmountTimerRef.current) {
              clearTimeout(unmountTimerRef.current);
              unmountTimerRef.current = null;
            }
            setMounted(true);
          } else {
            if (unmountTimerRef.current) clearTimeout(unmountTimerRef.current);
            unmountTimerRef.current = setTimeout(() => {
              setMounted(false);
              unmountTimerRef.current = null;
            }, UNMOUNT_DELAY_MS);
          }
        }
      },
      {
        root: root ?? null,
        rootMargin: ROOT_MARGIN,
      },
    );
    observer.observe(target);
    return () => {
      observer.disconnect();
      if (unmountTimerRef.current) {
        clearTimeout(unmountTimerRef.current);
        unmountTimerRef.current = null;
      }
    };
  }, [shouldLazy]);

  // Measure & cache height while mounted. useLayoutEffect so the cache
  // already reflects the latest value before any subsequent unmount swap.
  useLayoutEffect(() => {
    if (!mounted || !shouldLazy) return;
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = entry.contentRect.height;
        if (h > 0) {
          heightCache.set(cacheKey, h);
          setCachedHeight(h);
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [mounted, shouldLazy, cacheKey]);

  if (!shouldLazy) {
    return <>{children}</>;
  }

  return (
    <div
      ref={placeholderRef}
      style={cachedHeight !== undefined ? { minHeight: cachedHeight } : undefined}
    >
      {mounted ? <div ref={contentRef}>{children}</div> : null}
    </div>
  );
}
