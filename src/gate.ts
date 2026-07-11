/** Passcode gate for the deployed app. Resolves once unlocked (or when disabled). */

import { PASSCODE_SHA256 } from "./app-config";

const UNLOCK_KEY = "watchwhat.unlockedHash";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function ensureUnlocked(): Promise<void> {
  if (!PASSCODE_SHA256) return Promise.resolve();
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") return Promise.resolve();
  if (localStorage.getItem(UNLOCK_KEY) === PASSCODE_SHA256) return Promise.resolve();

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "lock-screen";
    overlay.innerHTML = `
      <div class="lock-box">
        <div class="lock-icon">📺</div>
        <h1>WatchWhat</h1>
        <input type="password" placeholder="Passcode" autocomplete="current-password" />
        <button class="btn primary">Unlock</button>
        <p class="lock-error" hidden>Wrong passcode</p>
      </div>`;
    document.body.append(overlay);

    const input = overlay.querySelector("input")!;
    const button = overlay.querySelector("button")!;
    const error = overlay.querySelector<HTMLElement>(".lock-error")!;
    input.focus();

    const attempt = async (): Promise<void> => {
      if ((await sha256Hex(input.value)) === PASSCODE_SHA256) {
        localStorage.setItem(UNLOCK_KEY, PASSCODE_SHA256);
        overlay.remove();
        resolve();
      } else {
        error.hidden = false;
        input.select();
      }
    };
    button.addEventListener("click", () => void attempt());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void attempt();
    });
  });
}
