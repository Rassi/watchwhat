import type { Route } from "../router";
import { el, toast, dialog, spinner } from "./components";
import { getSettings, saveSettings, defaultSettings } from "../data/settings";
import type { AppSettings } from "../data/settings";
import { applyTheme } from "../theme";
import { hardReload } from "./refresh";
import { pickServices } from "./servicePicker";
import { parseServiceRules } from "./shared";
import { checkJustWatch, getJustWatchHealth } from "../api/justwatch";
import { downloadBackup, exportBackup, importBackup, parseBackup, summarize } from "../data/transfer";
import { flush, getCursor, pendingCount, setCursor } from "../data/outbox";
import { syncEvents, syncNow } from "../data/replay";
import { syncConfigured, testConnection } from "../api/syncserver";
import { reconcileSettings } from "../data/cloudsettings";

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

    /**
     * What each control was last *filled with*, as opposed to typed into.
     *
     * A field counts as edited exactly when its current value differs from this,
     * which is the test for whether settings arriving from another device may
     * overwrite it. Comparing against the stored value instead would be wrong:
     * by the time that event fires the new value is already stored, so every
     * field that changed remotely would look edited and none would ever update.
     */
    const shown = new Map<string, unknown>();

    // --- TMDB ---
    const tmdbKey = textInput(settings.tmdbApiKey, "TMDB API key");
    shown.set("tmdbApiKey", settings.tmdbApiKey);
    const saveTmdbBtn = el("button", { class: "btn primary" }, "Save");
    saveTmdbBtn.addEventListener("click", () => {
      saveSettings({ tmdbApiKey: tmdbKey.value.trim() });
      shown.set("tmdbApiKey", tmdbKey.value.trim());
      toast("TMDB key saved");
      // Straight away rather than at the next sync: this is the one field the
      // other devices cannot do anything without.
      void reconcileSettings();
    });
    const tmdbHelp = el("p", {});
    tmdbHelp.innerHTML =
      `Now the main source: search, artwork, episode lists and air dates all come from here, so without a key ` +
      `you can only browse what is already saved. Get a free API key at ` +
      `<a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener"><b>themoviedb.org/settings/api</b></a> ` +
      `(the "API Key (v3 auth)" value).`;
    // Required by TMDB's terms of use, and more honest now that they carry the app.
    const tmdbAttribution = el("p", { class: "attribution" }, "This product uses the TMDB API but is not endorsed or certified by TMDB.");
    const tmdbCard = el(
      "div",
      { class: "card" },
      el("h2", {}, "TMDB (search & metadata)"),
      tmdbHelp,
      field("API key", tmdbKey),
      saveTmdbBtn,
      tmdbAttribution,
    );

    // --- OMDb (optional ratings) ---
    const omdbKey = textInput(settings.omdbApiKey, "OMDb API key");
    shown.set("omdbApiKey", settings.omdbApiKey);
    const saveOmdbBtn = el("button", { class: "btn primary" }, "Save");
    saveOmdbBtn.addEventListener("click", () => {
      saveSettings({ omdbApiKey: omdbKey.value.trim() });
      shown.set("omdbApiKey", omdbKey.value.trim());
      toast("OMDb key saved");
      void reconcileSettings();
    });
    const omdbHelp = el("p", {});
    omdbHelp.innerHTML =
      `Optional: adds IMDb and Rotten Tomatoes ratings to About pages. Get a free key (1,000 requests/day) at ` +
      `<a href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noopener"><b>omdbapi.com/apikey.aspx</b></a>. ` +
      `Ratings are fetched once per title per week, only when you open its page.`;
    const omdbCard = el("div", { class: "card" }, el("h2", {}, "OMDb (IMDb & Rotten Tomatoes ratings)"), omdbHelp, field("API key", omdbKey), saveOmdbBtn);

    // --- Sync ---
    // The token is per-device on purpose: the repo is public, so it can only ever
    // live in localStorage. The URL is not a secret and ships as a default. Those
    // two are also the only settings that *cannot* come from the server, being how
    // it is reached — which is what makes them the whole of a new device's setup.
    const syncUrlInput = textInput(settings.syncUrl, "https://…workers.dev");
    const syncTokenInput = textInput(settings.syncToken, "Sync token");
    const saveSyncBtn = el("button", { class: "btn primary" }, "Save");
    const syncNowBtn = el("button", { class: "btn" }, "Sync now");
    const testSyncBtn = el("button", { class: "btn" }, "Test");
    const syncStatus = el("p", { class: "diff-summary" }, "");

    const refreshSyncStatus = async (): Promise<void> => {
      const pending = await pendingCount();
      syncStatus.textContent = !syncConfigured()
        ? "Not configured — changes are saved on this device only."
        : pending === 0
          ? "Everything on this device has been uploaded."
          : `${pending} change${pending === 1 ? "" : "s"} waiting to upload.`;
    };
    void refreshSyncStatus();

    saveSyncBtn.addEventListener("click", async () => {
      saveSettings({ syncUrl: syncUrlInput.value.trim(), syncToken: syncTokenInput.value.trim() });
      toast("Sync settings saved");
      // A token arriving is often the reason a queue exists at all.
      await flush();
      await refreshSyncStatus();
    });

    syncNowBtn.addEventListener("click", async () => {
      if (!syncConfigured()) {
        toast("Enter a URL and token, then Save first");
        return;
      }
      syncNowBtn.textContent = "Syncing…";
      try {
        const { pushed, applied, skipped, settings: changedSettings } = await syncNow();
        const parts = [
          pushed ? `${pushed} uploaded` : "",
          applied ? `${applied} applied` : "",
          skipped ? `${skipped} skipped` : "",
          changedSettings.length ? `${changedSettings.length} setting${changedSettings.length === 1 ? "" : "s"} updated` : "",
        ].filter(Boolean);
        // The background redraw deliberately skips this screen so it can't eat a
        // half-typed draft, which leaves the inputs stale after an explicit Sync
        // now. Putting the arrived values back is safe here: only the fields that
        // actually changed are touched, and the user asked for this.
        if (changedSettings.length) showSavedValues(changedSettings);
        toast(parts.length ? `Synced — ${parts.join(", ")}` : "Synced — already up to date");
      } finally {
        syncNowBtn.textContent = "Sync now";
        await refreshSyncStatus();
      }
    });

    testSyncBtn.addEventListener("click", async () => {
      if (!syncConfigured()) {
        toast("Enter a URL and token, then Save first");
        return;
      }
      try {
        const page = await testConnection(await getCursor());
        const waiting = page.events.length === 0 ? "nothing new to pull" : `${page.events.length}${page.more ? "+" : ""} to pull`;
        toast(`Connected — ${waiting}`);
      } catch (err) {
        toast(`Sync failed: ${err instanceof Error ? err.message : "unknown error"}`);
      }
      await refreshSyncStatus();
    });

    /**
     * Wind the cursor back to nothing and replay the log from the start.
     *
     * The recovery for the one failure the cursor cannot describe: an event that was *pulled*
     * by a build too old to understand it. The cursor advances per page regardless — it has to,
     * or an event nothing can apply would wedge sync forever — so the day the app learns to read
     * that event, it is already behind the cursor and will never be offered again. That is
     * exactly what happened to the list dates: every device that synced while running the
     * previous build swallowed all 62 of them.
     *
     * Safe because replay is idempotent by construction: a watch already recorded is skipped
     * rather than counted twice, and a list membership already held lands on the same state.
     * That property is the whole reason the log is append-only, so leaning on it here costs
     * nothing beyond the time to walk the log.
     */
    const repullBtn = el("button", { class: "btn small" }, "Re-apply everything from the server…");
    repullBtn.addEventListener("click", async () => {
      if (!syncConfigured()) {
        toast("Enter a URL and token, then Save first");
        return;
      }
      const choice = await dialog(
        "Re-apply everything from the server?",
        "Reads every change on the server again from the beginning and re-applies it here. Use this when this " +
          "device is missing something the others have — usually because it synced while running an older " +
          "version of the app. Nothing is ever deleted, and re-applying something this device already has " +
          "changes nothing, so it is safe to run whenever a device looks out of step. It uploads this " +
          "device's own pending changes too, exactly as Sync now would.",
        [
          { label: "Cancel", value: "cancel", kind: "plain" },
          { label: "Re-apply", value: "go", kind: "primary" },
        ],
      );
      if (choice !== "go") return;

      repullBtn.textContent = "Re-applying…";
      try {
        await setCursor(0);
        const { applied, skipped } = await syncNow();
        const parts = [applied ? `${applied} applied` : "", skipped ? `${skipped} skipped` : ""].filter(Boolean);
        toast(parts.length ? `Re-applied — ${parts.join(", ")}` : "Re-applied — nothing on the server");
      } catch (err) {
        toast(`Re-apply failed: ${err instanceof Error ? err.message : "unknown error"}. Safe to try again.`, "error");
      } finally {
        repullBtn.textContent = "Re-apply everything from the server…";
        await refreshSyncStatus();
      }
    });

    const syncHelp = el("p", {});
    syncHelp.innerHTML =
      `Keeps this device and the others in step through your own Cloudflare Worker. Every change is saved locally ` +
      `first and queued, so marking something watched offline still works — the queue uploads next time the app has ` +
      `a connection. This happens by itself at startup, when the network returns and when you come back to the ` +
      `app; <b>Sync now</b> just does it on demand — uploading what is queued here and applying what is new ` +
      `elsewhere. <b>Test</b> checks the saved values, so Save first if you have just edited them.`;
    const syncScopeHelp = el(
      "p",
      {},
      "Your API keys and preferences ride along too, so setting up a new device is just these two fields — " +
        "everything else arrives on the first sync. The theme stays per-device.",
    );
    const syncCard = el(
      "div",
      { class: "card" },
      el("h2", {}, "Sync"),
      syncHelp,
      syncScopeHelp,
      field("Server URL", syncUrlInput),
      field("Token", syncTokenInput),
      el("div", { class: "field-row" }, saveSyncBtn, syncNowBtn, testSyncBtn),
      syncStatus,
      el(
        "p",
        { class: "field-help" },
        "Missing something the other devices have? Re-apply walks the whole history rather than just what is " +
          "new. It only ever adds, so running it costs nothing but time.",
      ),
      repullBtn,
    );

    // --- Preferences ---
    // Unlike the credential cards, these edit a draft: nothing is written until Save. Each
    // field's Reset puts the shipped default back into the draft, and saving a value equal to
    // the default unpins the field so it follows future defaults again.
    const staleInput = el("input", { type: "number", min: "7", max: "365" });
    const themeSelect = el("select", { class: "season-select" });
    for (const [value, label] of [["auto", "Auto (follow system)"], ["dark", "Dark"], ["light", "Light"]] as const) {
      themeSelect.append(el("option", { value }, label));
    }
    // Still the draft's source of truth, so every Reset/Save/diff path keeps working
    // unchanged — but no longer the thing you look at. It lives behind "Edit as text"
    // now that the picker writes TMDB's exact spellings and hand-editing them is a
    // good way to produce an entry that matches nothing.
    const servicesInput = textInput("", "Netflix, Disney Plus, …");
    const countriesInput = textInput("", "DK, US, GB");
    const servicesChips = el("div", { class: "service-chips" });

    /** The services draft as chips: what is yours, and where it counts. */
    function renderServiceChips(): void {
      const rules = parseServiceRules(servicesInput.value);
      if (rules.length === 0) {
        servicesChips.replaceChildren(el("span", { class: "service-chip-empty" }, "No services chosen"));
        return;
      }
      // Sort on the displayed name, not the raw entry: "@US/DK" and a leading "-"
      // would otherwise decide the order and scatter a service's variants apart.
      const label = (text: string): string => text.replace(/^-/, "").split("@")[0].trim();
      const sorted = [...rules].sort(
        (a, b) => Number(a.blocked) - Number(b.blocked) || label(a.text).localeCompare(label(b.text)),
      );
      servicesChips.replaceChildren(
        ...sorted.map((r) =>
          el(
            "span",
            { class: `service-chip${r.blocked ? " blocked" : ""}`, title: r.text },
            el("span", { class: "service-chip-name" }, label(r.text)),
            r.countries ? el("span", { class: "service-chip-cc" }, r.countries.join("/")) : null,
          ),
        ),
      );
    }

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

    /** Put the stored value of named fields back into their controls. */
    function showSavedValues(keys: readonly string[]): void {
      const saved = getSettings();
      if (keys.includes("tmdbApiKey")) shown.set("tmdbApiKey", (tmdbKey.value = saved.tmdbApiKey));
      if (keys.includes("omdbApiKey")) shown.set("omdbApiKey", (omdbKey.value = saved.omdbApiKey));
      for (const p of prefs) {
        if (!keys.includes(p.key)) continue;
        (p.show as (v: unknown) => void)(saved[p.key]);
        shown.set(p.key, saved[p.key]);
      }
      syncPrefButtons();
    }

    /** Whether the user has changed a control since it was last filled from storage. */
    function edited(key: string, current: unknown): boolean {
      return shown.has(key) && current !== shown.get(key);
    }


    /** Fields whose draft value would change if the defaults were put back. */
    const offDefault = (): typeof prefs => prefs.filter((p) => p.draft() !== defaultSettings[p.key]);

    /** Reset lights up when a field differs from its default, Save when anything is unsaved. */
    function syncPrefButtons(): void {
      // Every path that changes the draft — typing, Reset, Save, the picker, a value
      // arriving from another device — already ends here, so the chips redraw from one place.
      renderServiceChips();
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

    for (const p of prefs) {
      (p.show as (v: unknown) => void)(settings[p.key]);
      shown.set(p.key, settings[p.key]);
    }
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
      for (const p of prefs) {
        (p.show as (v: unknown) => void)(patch[p.key]); // reflect trimming/clamping
        shown.set(p.key, patch[p.key]);
      }
      applyTheme();
      syncPrefButtons();
      toast("Preferences saved");
      // Everything here except the theme is shared, and only what actually
      // changed carries a new timestamp, so a Save that touched nothing sends nothing.
      void reconcileSettings();
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
      el(
        "div",
        { class: "field" },
        el("label", {}, "My streaming services (highlighted under Where to watch)"),
        el("div", { class: "field-row" }, servicesChips, resetBtns.get("myServices")!),
      ),
      el("div", { class: "button-row" }, pickBtn),
      el(
        "p",
        { class: "field-help" },
        "Struck-through chips are ones you've blocked: they never count as yours or as free, " +
          "however TMDB lists them. The code after a name is the countries it counts in — a " +
          "subscription in one country is no help in another. Free-to-air services need no entry " +
          "at all; they're detected automatically.",
      ),
      el(
        "details",
        { class: "service-raw" },
        el("summary", {}, "Edit as text"),
        el(
          "p",
          { class: "field-help" },
          'Comma-separated. Names must match TMDB\'s spelling exactly, which is why the picker is ' +
            'the better way in — "Prime" matches nothing; "Amazon Prime Video" does. Add "@DK/US" ' +
            'to limit an entry to those countries, or a leading "-" to block it.',
        ),
        servicesInput,
      ),
      prefField("Where-to-watch countries (ISO codes, comma-separated)", countriesInput, "watchCountries"),
      el(
        "p",
        { class: "field-help" },
        "Reset restores a field to its default. Fields left on their default follow along when the app ships new ones, " +
          "on every device — a reset travels like any other change. Saving here syncs to your other devices; the most " +
          "recent edit of a given field wins.",
      ),
      el("div", { class: "button-row" }, saveBtn, resetAllBtn),
    );

    /**
     * Settings that arrived from another device while this screen is open.
     *
     * `main.ts` deliberately does not redraw the route for these, because the
     * preference controls hold an unsaved draft. So update just the fields that
     * moved, and of those only the ones sitting on their saved value — a field
     * being edited keeps what is typed in it, and its Save button stays lit, so
     * the user's own edit still wins if they go through with it.
     */
    const onRemoteSettings = (e: Event): void => {
      const detail = (e as CustomEvent<{ settingsOnly?: boolean; keys?: string[] }>).detail;
      if (!detail?.settingsOnly || !detail.keys?.length) return;
      // The router replaces the container's children without unmounting anything,
      // so this listener outlives the screen it belongs to. Retiring it once the
      // card is detached stops them stacking up one per visit to Settings.
      if (!prefsCard.isConnected) {
        syncEvents.removeEventListener("applied", onRemoteSettings);
        return;
      }
      const quiet = detail.keys.filter((key) => {
        const pref = prefs.find((p) => p.key === key);
        if (pref) return !edited(key, pref.draft());
        if (key === "tmdbApiKey") return !edited(key, tmdbKey.value.trim());
        if (key === "omdbApiKey") return !edited(key, omdbKey.value.trim());
        return true;
      });
      if (quiet.length) showSavedValues(quiet);
    };
    syncEvents.addEventListener("applied", onRemoteSettings);

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

    // --- Transfer ---
    // The only way a library reaches another device now that there is no server
    // between them: a file out of one, into the other.
    const exportBtn = el("button", { class: "btn primary" }, "Export my data");
    exportBtn.addEventListener("click", async () => {
      exportBtn.disabled = true;
      try {
        const backup = await exportBackup();
        const { shows, movies, episodes } = summarize(backup);
        downloadBackup(backup);
        toast(`Exported ${shows} shows, ${movies} movies, ${episodes} watched episodes`);
      } catch (e) {
        toast(e instanceof Error ? e.message : "Export failed", "error");
      }
      exportBtn.disabled = false;
    });

    const importInput = el("input", { type: "file", accept: "application/json,.json" }) as HTMLInputElement;
    importInput.style.display = "none";
    const importBtn = el("button", { class: "btn" }, "Import from a file");
    importBtn.addEventListener("click", () => importInput.click());
    importInput.addEventListener("change", async () => {
      const file = importInput.files?.[0];
      importInput.value = ""; // so picking the same file twice still fires
      if (!file) return;
      try {
        const backup = parseBackup(await file.text());
        const { shows, movies, episodes } = summarize(backup);
        const choice = await dialog(
          "Replace this device's data?",
          `The file holds ${shows} shows, ${movies} movies and ${episodes} watched episodes. ` +
            `Everything currently on this device is replaced by it — anything you marked watched here and ` +
            `nowhere else would be lost.`,
          [
            { label: "Import", value: "yes", kind: "danger" },
            { label: "Cancel", value: "no" },
          ],
        );
        if (choice !== "yes") return;
        await importBackup(backup);
        toast("Imported — reloading…");
        setTimeout(() => hardReload(), 600);
      } catch (e) {
        toast(e instanceof Error ? e.message : "Import failed", "error");
      }
    });

    const transferCard = el(
      "div",
      { class: "card" },
      el("h2", {}, "Backup and restore"),
      el(
        "p",
        {},
        "With Sync set up, a new device needs nothing from here — it rebuilds itself from the server. This is " +
          "the way back when there is no server to rebuild from: a file to keep somewhere safe, and the way to " +
          "start a device from an older library. Nothing is uploaded anywhere; the file never leaves your devices.",
      ),
      el(
        "p",
        {},
        "Importing replaces the receiving device's library rather than merging it, and the server is not told " +
          "about any of it — the device carries on syncing from wherever it had got to, applying anything newer " +
          "on top of what you imported.",
      ),
      el("div", { class: "btn-row" }, exportBtn, importBtn),
      importInput,
    );

    // --- Data ---
    const clearBtn = el("button", { class: "btn danger" }, "Clear cached data");
    clearBtn.addEventListener("click", async () => {
      const choice = await dialog(
        "Clear this device's data?",
        "Everything WatchWhat has stored here is deleted. There is no server to rebuild it from, so export " +
          "first unless another device has a copy.",
        [
          { label: "Clear", value: "yes", kind: "danger" },
          { label: "Cancel", value: "no" },
        ],
      );
      if (choice !== "yes") return;
      indexedDB.deleteDatabase("watchwhat");
      toast("Cleared — reloading…");
      setTimeout(() => hardReload(), 600);
    });
    const dataCard = el(
      "div",
      { class: "card" },
      el("h2", {}, "Data"),
      el("p", {}, "Deletes the local library (shows, progress, movies, images) from this device."),
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

    // --- Poster flicker test ---
    // Temporary, and meant to be deleted along with public/lazytest.html once the flicker after a
    // 12-hour-old open is understood. It lives here because the symptom only ever appears on the
    // home-screen app, which has no address bar to type a URL into. A plain link, not a new tab:
    // iOS would hand target="_blank" to Safari and the test would then run in a different engine
    // context than the one being measured. The page itself offers the way back.
    const flickerCard = el(
      "div",
      { class: "card" },
      el("h2", {}, "Poster flicker test"),
      el(
        "p",
        {},
        "Rebuilds a grid of already-loaded posters the way a bulk refresh does, to find out why " +
          "they blank out for a few seconds after a long-closed open. Takes about 25 seconds — " +
          "watch the posters while it runs.",
      ),
      el("a", { class: "btn", href: "lazytest.html" }, "Open the test"),
    );

    // Ordered by how often a card is actually wanted, not by how fundamental it is.
    // Reload is the most-used control on this screen — it is the only way to pick up
    // a new build on an iPhone home-screen app — and the credentials are the least
    // used, being typed once per device and never again now that they sync.
    container.append(
      versionCard,
      prefsCard,
      justWatchCard,
      tmdbCard,
      omdbCard,
      syncCard,
      transferCard,
      dataCard,
      flickerCard,
    );
  },
};
