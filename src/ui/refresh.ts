/**
 * Reloading an installed home-screen app. iOS gives a standalone web app no
 * browser chrome — no reload button, no native pull-to-refresh — and keeps the
 * page alive across launches from the App Switcher, so a stale build can stick
 * around indefinitely with no way for the user to break out of it.
 */

import { el } from "./components";

/** Reload, guaranteeing a fresh index.html rather than a cache revalidation. */
export function hardReload(): void {
  location.replace(`${location.pathname}?r=${Date.now()}${location.hash}`);
}

/** Drop the cache-buster afterwards so it doesn't linger in the visible URL. */
export function stripReloadParam(): void {
  if (location.search) history.replaceState(null, "", location.pathname + location.hash);
}

const THRESHOLD = 70;

/**
 * Pull down from the top of the page to reload. Listeners stay passive: iOS's
 * own rubber-band overscroll provides the physical feedback, and preventing
 * default here would only fight the scroller.
 */
export function installPullToRefresh(): void {
  const indicator = el("div", { class: "pull-refresh" }, "Pull to refresh");
  document.body.append(indicator);

  let startY: number | null = null;
  let ready = false;

  const reset = (): void => {
    startY = null;
    ready = false;
    indicator.classList.remove("visible", "ready");
    indicator.style.transform = "";
  };

  window.addEventListener(
    "touchstart",
    (e) => {
      // Only from the very top, and only single-finger — otherwise this triggers
      // during momentum scrolling and pinch-zoom.
      startY = window.scrollY <= 0 && e.touches.length === 1 ? e.touches[0]!.clientY : null;
      ready = false;
    },
    { passive: true },
  );

  window.addEventListener(
    "touchmove",
    (e) => {
      if (startY === null) return;
      const dy = e.touches[0]!.clientY - startY;
      if (dy <= 0 || window.scrollY > 0) {
        reset();
        return;
      }
      ready = dy >= THRESHOLD;
      indicator.classList.add("visible");
      indicator.classList.toggle("ready", ready);
      indicator.textContent = ready ? "Release to refresh" : "Pull to refresh";
      indicator.style.transform = `translateY(${Math.min(dy, THRESHOLD * 1.6)}px)`;
    },
    { passive: true },
  );

  window.addEventListener(
    "touchend",
    () => {
      if (startY !== null && ready) {
        indicator.textContent = "Refreshing…";
        hardReload();
        return;
      }
      reset();
    },
    { passive: true },
  );
}
