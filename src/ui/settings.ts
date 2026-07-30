import type { Route } from "../router";
import { el, toast, dialog, spinner } from "./components";
import { getSettings, saveSettings, isAuthenticated, isConfigured, defaultSettings } from "../data/settings";
import type { AppSettings } from "../data/settings";
import { requestDeviceCode, pollForDeviceToken, logout, getLastActivities, TraktError, BAD_CLIENT } from "../api/trakt";
import { applyTheme } from "../theme";
import { hardReload } from "./refresh";
import { pickServices } from "./servicePicker";
import { checkJustWatch, getJustWatchHealth } from "../api/justwatch";

function field(labelText: string, input: HTMLInputElement): HTMLElement {
  return el("div", { class: "field" }, el("label", {}, labelText), input);
}

function textInput(value: string, placeholder = ""): HTMLInputElement {
  const input = el("input", { type: "text", placeholder, autocapitalize: "off", autocomplete: "off", spellcheck: "false" });
  input.value = value;
  return input;
}

function splitList(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Which entries a comma list would lose and gain. Comparing the two lists as whole strings
 * is useless once they are eleven services long — the one that changed is impossible to spot.
 */
function listDiff(from: string, to: string): { removed: string[]; added: string[]; kept: number } {
  const before = splitList(from);
  const after = splitList(to);
  const key = (s: string): string => s.toLowerCase();
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));
  return {
    removed: before.filter((s) => !afterKeys.has(key(s))),
    added: after.filter((s) => !beforeKeys.has(key(s))),
    kept: before.filter((s) => afterKeys.has(key(s))).length,
  };
}

/** How a preference would change: entry-by-entry for lists, plainly for everything else. */
function diffNode(isList: boolean, from: string, to: string): HTMLElement {
  if (!isList) {
    return el(
      "div",
      { class: "diff-scalar" },
      el("span", { class: "diff-from" }, from),
      el("span", { class: "diff-arrow" }, "→"),
      el("span", { class: "diff-to" }, to),
    );
  }
  const { removed, added, kept } = listDiff(from, to);
  const chips = el("div", { class: "diff-chips" });
  for (const item of removed) chips.append(el("span", { class: "diff-chip removed" }, item));
  for (const item of added) chips.append(el("span", { class: "diff-chip added" }, item));
  const parts = [
    removed.length ? `${removed.length} removed` : "",
    added.length ? `${added.length} added` : "",
    kept ? `${kept} unchanged` : "",
  ].filter(Boolean);
  return el("div", {}, chips, el("p", { class: "diff-summary" }, parts.join(" · ")));
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
      `<a href="https://app.trakt.tv/settings/apps/api" target="_blank" rel="noopener"><b>app.trakt.tv/settings/apps/api</b></a>. ` +
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
            // A dead Client ID also comes back as a 401, but reconnecting can't fix that one.
            if (e instanceof TraktError && e.message === BAD_CLIENT) status.textContent = BAD_CLIENT;
            else status.textContent = e instanceof TraktError && e.status === 401 ? "Session expired — reconnect below." : "Connected, but Trakt could not be reached right now.";
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

    // --- OMDb (optional ratings) ---
    const omdbKey = textInput(settings.omdbApiKey, "OMDb API key");
    const saveOmdbBtn = el("button", { class: "btn primary" }, "Save");
    saveOmdbBtn.addEventListener("click", () => {
      saveSettings({ omdbApiKey: omdbKey.value.trim() });
      toast("OMDb key saved");
    });
    const omdbHelp = el("p", {});
    omdbHelp.innerHTML =
      `Optional: adds IMDb and Rotten Tomatoes ratings to About pages. Get a free key (1,000 requests/day) at ` +
      `<a href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noopener"><b>omdbapi.com/apikey.aspx</b></a>. ` +
      `Ratings are fetched once per title per week, only when you open its page.`;
    const omdbCard = el("div", { class: "card" }, el("h2", {}, "OMDb (IMDb & Rotten Tomatoes ratings)"), omdbHelp, field("API key", omdbKey), saveOmdbBtn);

    // --- Preferences ---
    // Unlike the credential cards, these edit a draft: nothing is written until Save. Each
    // field's Reset puts the shipped default back into the draft, and saving a value equal to
    // the default unpins the field so it follows future defaults again.
    const staleInput = el("input", { type: "number", min: "7", max: "365" });
    const themeSelect = el("select", { class: "season-select" });
    for (const [value, label] of [["auto", "Auto (follow system)"], ["dark", "Dark"], ["light", "Light"]] as const) {
      themeSelect.append(el("option", { value }, label));
    }
    const servicesInput = textInput("", "Netflix, Disney+, …");
    const countriesInput = textInput("", "DK, US, GB");

    // Each control's draft value, normalised exactly as it would be stored, so comparing
    // against the saved value and the default is a plain equality check.
    const clampDays = (v: string): number => Math.max(7, Math.min(365, Number(v) || defaultSettings.staleDays));
    const prefs = [
      {
        key: "staleDays" as const,
        label: '"Not watched for a while" cutoff (days)',
        list: false,
        draft: (): AppSettings["staleDays"] => clampDays(staleInput.value),
        show: (v: AppSettings["staleDays"]) => (staleInput.value = String(v)),
      },
      {
        key: "theme" as const,
        label: "Theme",
        list: false,
        draft: (): AppSettings["theme"] => themeSelect.value as AppSettings["theme"],
        show: (v: AppSettings["theme"]) => (themeSelect.value = v),
      },
      {
        key: "myServices" as const,
        label: "My streaming services",
        list: true,
        draft: (): string => servicesInput.value.trim(),
        show: (v: string) => (servicesInput.value = v),
      },
      {
        key: "watchCountries" as const,
        label: "Where-to-watch countries",
        list: true,
        draft: (): string => countriesInput.value.trim(),
        show: (v: string) => (countriesInput.value = v),
      },
    ];

    const saveBtn = el("button", { class: "btn primary" }, "Save preferences");
    const resetAllBtn = el("button", { class: "btn danger", type: "button" }, "Reset all");
    const resetBtns = new Map<string, HTMLButtonElement>();
    // A list is worth confirming — you cannot eyeball which of eleven services you are about
    // to drop. A cutoff or a theme is its own preview, so those reset on the spot.
    for (const p of prefs) {
      const btn = el("button", { class: "btn small", type: "button", title: "Restore the default" }, "Reset");
      btn.addEventListener("click", async () => {
        const from = String(p.draft());
        const to = String(defaultSettings[p.key]);
        if (p.list && from !== to) {
          const body = el(
            "div",
            {},
            el("p", {}, "The default list would replace what you have. Nothing is stored until you press Save."),
            el("div", { class: "reset-diff" }, diffNode(true, from, to)),
          );
          const choice = await dialog(`Reset ${p.label.toLowerCase()}?`, body, [
            { label: "Cancel", value: "cancel", kind: "plain" },
            { label: "Reset", value: "reset", kind: "danger" },
          ]);
          if (choice !== "reset") return;
        }
        (p.show as (v: unknown) => void)(defaultSettings[p.key]);
        syncPrefButtons();
      });
      resetBtns.set(p.key, btn);
    }

    /** Fields whose draft value would change if the defaults were put back. */
    const offDefault = (): typeof prefs => prefs.filter((p) => p.draft() !== defaultSettings[p.key]);

    /** Reset lights up when a field differs from its default, Save when anything is unsaved. */
    function syncPrefButtons(): void {
      const saved = getSettings();
      let dirty = false;
      for (const p of prefs) {
        const draft = p.draft();
        resetBtns.get(p.key)!.toggleAttribute("disabled", draft === defaultSettings[p.key]);
        if (draft !== saved[p.key]) dirty = true;
      }
      saveBtn.toggleAttribute("disabled", !dirty);
      resetAllBtn.toggleAttribute("disabled", offDefault().length === 0);
    }

    // Worth a confirm: one click can change four fields at once, unlike a per-field Reset
    // where the value you are replacing is right there in the input.
    resetAllBtn.addEventListener("click", async () => {
      const rows = offDefault().map((p) =>
        el(
          "div",
          { class: "reset-row" },
          el("span", { class: "reset-label" }, p.label),
          diffNode(p.list, String(p.draft()), String(defaultSettings[p.key])),
        ),
      );
      const body = el(
        "div",
        {},
        el("p", {}, "These fields go back to their defaults in the form. Nothing is stored until you press Save."),
        el("div", { class: "reset-diff" }, ...rows),
      );
      const choice = await dialog("Reset all preferences?", body, [
        { label: "Cancel", value: "cancel", kind: "plain" },
        { label: "Reset all", value: "reset", kind: "danger" },
      ]);
      if (choice !== "reset") return;
      for (const p of prefs) (p.show as (v: unknown) => void)(defaultSettings[p.key]);
      syncPrefButtons();
    });

    for (const p of prefs) (p.show as (v: unknown) => void)(settings[p.key]);
    for (const input of [staleInput, servicesInput, countriesInput]) {
      input.addEventListener("input", syncPrefButtons);
    }
    themeSelect.addEventListener("change", syncPrefButtons);
    staleInput.addEventListener("change", () => {
      staleInput.value = String(clampDays(staleInput.value));
      syncPrefButtons();
    });

    saveBtn.addEventListener("click", () => {
      const patch: Partial<AppSettings> = {};
      for (const p of prefs) (patch as Record<string, unknown>)[p.key] = p.draft();
      saveSettings(patch);
      for (const p of prefs) (p.show as (v: unknown) => void)(patch[p.key]); // reflect trimming/clamping
      applyTheme();
      syncPrefButtons();
      toast("Preferences saved");
    });
    syncPrefButtons();

    const prefField = (labelText: string, input: HTMLElement, key: string): HTMLElement =>
      el("div", { class: "field" }, el("label", {}, labelText), el("div", { class: "field-row" }, input, resetBtns.get(key)!));

    // Names have to match TMDB's spelling to be any use, so offer the ones it actually sent
    // rather than making them a guess. Edits land in the draft like any other, so Save still
    // decides.
    const pickBtn = el("button", { class: "btn small", type: "button" }, "Choose from my library…");
    pickBtn.addEventListener("click", async () => {
      pickBtn.disabled = true;
      try {
        const picked = await pickServices(servicesInput.value.trim(), countriesInput.value.trim());
        if (picked !== null) {
          servicesInput.value = picked;
          syncPrefButtons();
        }
      } catch (e) {
        toast(e instanceof Error ? e.message : "Could not read cached services", "error");
      } finally {
        pickBtn.disabled = false;
      }
    });

    const prefsCard = el(
      "div",
      { class: "card" },
      el("h2", {}, "Preferences"),
      prefField('Days before a show counts as "not watched for a while"', staleInput, "staleDays"),
      el(
        "p",
        { class: "field-help" },
        'Controls when a show drops out of Watch next. Shows with a new episode waiting stay regardless. Tap the ⓘ next to any section heading to see exactly what lands in it.',
      ),
      prefField("Theme", themeSelect, "theme"),
      prefField("My streaming services (comma-separated — highlighted under Where to watch)", servicesInput, "myServices"),
      el("div", { class: "button-row" }, pickBtn),
      el(
        "p",
        { class: "field-help" },
        'A subscription only counts in the countries it works in: write "Netflix@DK/US" to limit one; ' +
          "a plain name counts everywhere. Put a minus in front of one you can't actually use — " +
          '"-Kanopy" — and it never counts as yours or as free, however TMDB lists it. ' +
          "Free-to-air services need no entry at all; they're detected automatically.",
      ),
      prefField("Where-to-watch countries (ISO codes, comma-separated)", countriesInput, "watchCountries"),
      el(
        "p",
        { class: "field-help" },
        "Reset restores a field to its default. Fields left on their default follow along when the app ships new ones.",
      ),
      el("div", { class: "button-row" }, saveBtn, resetAllBtn),
    );

    // --- JustWatch top-ups ---
    // Two halves on purpose. The passive line is what real top-ups did, which is the only thing
    // that can tell a schema break from a title JustWatch simply does not carry. The check is for
    // when you want an answer now, and asserts on response shape rather than pinging — a rename
    // is what would quietly stop this working, and a reachable endpoint says nothing about that.
    const jwStatus = el("p", { class: "field-help" });
    const jwResults = el("div", {});
    const jwBtn = el("button", { class: "btn" }, "Run check");

    function renderJwStatus(): void {
      const health = getJustWatchHealth();
      if (!health) {
        jwStatus.textContent = "No top-up has run on this device yet. They only fire for titles within a month of a release date.";
        return;
      }
      const when = new Date(health.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      const unknown = health.unknownKinds?.length ? ` Unmapped offer types seen: ${health.unknownKinds.join(", ")}.` : "";
      jwStatus.textContent = `Last top-up ${health.ok ? "succeeded" : "did not complete"} on ${when} — ${health.detail}.${unknown}`;
    }
    renderJwStatus();

    jwBtn.addEventListener("click", async () => {
      jwBtn.disabled = true;
      jwBtn.textContent = "Checking…";
      jwResults.replaceChildren(spinner("Querying JustWatch…"));
      try {
        // The draft countries, not the saved ones: checking what you are about to save is the
        // more useful answer, and country aliasing is one of the things that can break.
        const countries = (countriesInput.value.trim() || defaultSettings.watchCountries).split(",");
        const checks = await checkJustWatch(countries);
        const list = el("ul", { class: "info-list" });
        for (const c of checks) {
          list.append(el("li", {}, `${c.ok ? "✓" : "✗"} ${c.label} — ${c.detail}`));
        }
        const failed = checks.filter((c) => !c.ok).length;
        jwResults.replaceChildren(
          list,
          el(
            "p",
            { class: "field-help" },
            failed === 0
              ? "Everything this feature depends on is intact."
              : `${failed} check(s) failed. Provider rows fall back to TMDB alone, so nothing is broken — just no longer topped up.`,
          ),
        );
      } catch (e) {
        jwResults.replaceChildren(el("p", { class: "field-help" }, e instanceof Error ? e.message : "Check failed"));
      } finally {
        jwBtn.disabled = false;
        jwBtn.textContent = "Run check";
      }
    });

    const justWatchCard = el(
      "div",
      { class: "card" },
      el("h2", {}, "JustWatch top-ups"),
      el(
        "p",
        {},
        "Titles near a release get their providers topped up straight from JustWatch, because TMDB's copy of " +
          "the same data lags by days exactly when it matters. It is an unofficial API with no version " +
          "guarantee, so this is here to tell you when it stops working — provider rows quietly fall back to " +
          "TMDB alone rather than breaking.",
      ),
      jwStatus,
      jwBtn,
      jwResults,
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

    // --- App version ---
    const reloadBtn = el("button", { class: "btn" }, "Reload app");
    reloadBtn.addEventListener("click", () => hardReload());
    const versionCard = el(
      "div",
      { class: "card" },
      el("h2", {}, "App version"),
      el("p", {}, `Build ${__BUILD_STAMP__}`),
      el(
        "p",
        {},
        "Reload fetches the latest deployed build. Handy on an iPhone home-screen app, which has no reload button — " +
          "you can also pull down from the top of any list to do the same.",
      ),
      reloadBtn,
    );

    container.append(traktCard, connectCard, tmdbCard, omdbCard, prefsCard, justWatchCard, dataCard, versionCard);
  },
};
