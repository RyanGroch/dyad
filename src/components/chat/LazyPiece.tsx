import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

const LAZY_THRESHOLD = 2000;
const ROOT_MARGIN = "1500px 0px 1500px 0px";
const UNMOUNT_DELAY_MS = 1500;

const heightCache = new Map<string, number>();

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
}

export function LazyPiece({
  children,
  pinned,
  sizeHint,
  cacheKey,
  disabled,
}: LazyPieceProps) {
  const shouldLazy = !disabled && !pinned && sizeHint >= LAZY_THRESHOLD;
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const unmountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mounted, setMounted] = useState(!shouldLazy);
  const [cachedHeight, setCachedHeight] = useState<number | undefined>(() =>
    heightCache.get(cacheKey),
  );

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
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
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
