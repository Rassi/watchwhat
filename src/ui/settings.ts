import type { Route } from "../router";
import { el, toast } from "./components";
import { getSettings, saveSettings, isAuthenticated, isConfigured } from "../data/settings";
import { requestDeviceCode, pollForDeviceToken, logout, getLastActivities, TraktError } from "../api/trakt";
import { reconcileCard } from "./reconcile";
import { applyTheme } from "../theme";

function field(labelText: string, input: HTMLInputElement): HTMLElement {
  return el("div", { class: "field" }, el("label", {}, labelText), input);
}

function textInput(value: string, placeholder = ""): HTMLInputElement {
  const input = el("input", { type: "text", placeholder, autocapitalize: "off", autocomplete: "off", spellcheck: "false" });
  input.value = value;
  return input;
}

export const settingsRoute: Route = {
  name: "settings",
  title: "Settings · WatchWhat",
  render(container) {
    const settings = getSettings();

    // --- Trakt API app credentials ---
    const clientId = textInput(settings.traktClientId, "Client ID");
    const clientSecret = textInput(settings.traktClientSecret, "Client Secret");
    const saveTraktBtn = el("button", { class: "btn primary" }, "Save");
    saveTraktBtn.addEventListener("click", () => {
      saveSettings({ traktClientId: clientId.value.trim(), traktClientSecret: clientSecret.value.trim() });
      toast("Trakt credentials saved");
      renderConnectCard();
    });

    const traktHelp = el("p", {});
    traktHelp.innerHTML =
      `One-time setup: create your own (free) API app at ` +
      `<a href="https://trakt.tv/oauth/applications/new" target="_blank" rel="noopener"><b>trakt.tv/oauth/applications</b></a>. ` +
      `Name: anything (e.g. WatchWhat). Redirect URI: <code>urn:ietf:wg:oauth:2.0:oob</code>. ` +
      `Then paste the Client ID and Secret here — they stay in this browser only.`;

    const traktCard = el(
      "div",
      { class: "card" },
      el("h2", {}, "Trakt API app"),
      traktHelp,
      field("Client ID", clientId),
      field("Client Secret", clientSecret),
      saveTraktBtn,
    );

    // --- Connect / login ---
    const connectCard = el("div", { class: "card" });

    function renderConnectCard(): void {
      connectCard.replaceChildren(el("h2", {}, "Trakt account"));
      if (!isConfigured()) {
        connectCard.append(el("p", {}, "Save your Trakt API credentials above first."));
        return;
      }
      if (isAuthenticated()) {
        const status = el("p", {}, "Connected ✓ (verifying…)");
        getLastActivities()
          .then(() => (status.textContent = "Connected ✓"))
          .catch((e: unknown) => {
            status.textContent = e instanceof TraktError && e.status === 401 ? "Session expired — reconnect below." : "Connected, but Trakt could not be reached right now.";
          });
        const disconnectBtn = el("button", { class: "btn danger" }, "Disconnect");
        disconnectBtn.addEventListener("click", () => {
          logout();
          toast("Disconnected from Trakt");
          renderConnectCard();
        });
        connectCard.append(status, disconnectBtn);
        return;
      }
      const connectBtn = el("button", { class: "btn primary" }, "Connect to Trakt");
      const info = el("div", {});
      connectBtn.addEventListener("click", async () => {
        connectBtn.disabled = true;
        try {
          const code = await requestDeviceCode();
          info.replaceChildren(
            el("p", {}, "Go to the link below (on any device) and enter this code:"),
            el("div", { class: "device-code" }, code.user_code),
            (() => {
              const p = el("p", { style: "text-align:center" });
              const a = el("a", { href: code.verification_url, target: "_blank", rel: "noopener" }, code.verification_url);
              (a as HTMLElement).style.color = "var(--accent)";
              p.append(a);
              return p;
            })(),
            el("p", { style: "text-align:center" }, "Waiting for approval…"),
          );
          await pollForDeviceToken(code);
          toast("Connected to Trakt ✓");
          renderConnectCard();
        } catch (e) {
          toast(e instanceof Error ? e.message : "Login failed", "error");
          connectBtn.disabled = false;
          info.replaceChildren();
        }
      });
      connectCard.append(connectBtn, info);
    }
    renderConnectCard();

    // --- TMDB ---
    const tmdbKey = textInput(settings.tmdbApiKey, "TMDB API key");
    const saveTmdbBtn = el("button", { class: "btn primary" }, "Save");
    saveTmdbBtn.addEventListener("click", () => {
      saveSettings({ tmdbApiKey: tmdbKey.value.trim() });
      toast("TMDB key saved");
    });
    const tmdbHelp = el("p", {});
    tmdbHelp.innerHTML =
      `Used for posters and artwork. Get a free API key at ` +
      `<a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener"><b>themoviedb.org/settings/api</b></a> ` +
      `(the "API Key (v3 auth)" value).`;
    const tmdbCard = el("div", { class: "card" }, el("h2", {}, "TMDB (images)"), tmdbHelp, field("API key", tmdbKey), saveTmdbBtn);

    // --- Preferences ---
    const staleInput = el("input", { type: "number", min: "7", max: "365" });
    staleInput.value = String(settings.staleDays);
    staleInput.addEventListener("change", () => {
      const days = Math.max(7, Math.min(365, Number(staleInput.value) || 30));
      staleInput.value = String(days);
      saveSettings({ staleDays: days });
      toast(`Shows move to "Haven't watched for a while" after ${days} days`);
    });
    const themeSelect = el("select", { class: "season-select" });
    for (const [value, label] of [["auto", "Auto (follow system)"], ["dark", "Dark"], ["light", "Light"]] as const) {
      const opt = el("option", { value }, label);
      if (settings.theme === value) opt.setAttribute("selected", "");
      themeSelect.append(opt);
    }
    themeSelect.addEventListener("change", () => {
      saveSettings({ theme: themeSelect.value as "auto" | "dark" | "light" });
      applyTheme();
    });

    const prefsCard = el(
      "div",
      { class: "card" },
      el("h2", {}, "Preferences"),
      field('Days before a show counts as "not watched for a while"', staleInput),
      el("div", { class: "field" }, el("label", {}, "Theme"), themeSelect),
    );

    // --- Data ---
    const clearBtn = el("button", { class: "btn danger" }, "Clear cached data");
    clearBtn.addEventListener("click", () => {
      indexedDB.deleteDatabase("watchwhat");
      toast("Cache cleared — it will be rebuilt from Trakt on next load");
    });
    const dataCard = el(
      "div",
      { class: "card" },
      el("h2", {}, "Data"),
      el("p", {}, "Clears the local cache (shows, progress, images). Your Trakt data is untouched."),
      clearBtn,
    );

    container.append(traktCard, connectCard, tmdbCard, prefsCard, reconcileCard(), dataCard);
  },
};
