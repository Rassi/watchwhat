import { execSync } from "node:child_process";
import { defineConfig } from "vite";

/**
 * Build date + commit, shown in Settings. Without it there's no way to answer
 * "is the installed home-screen app actually running the latest deploy?".
 */
function buildStamp(): string {
  // GITHUB_SHA first: the deployed build is the one that matters here, and CI
  // hands it over without depending on git being on PATH.
  let sha = process.env.GITHUB_SHA?.slice(0, 7);
  if (!sha) {
    try {
      sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
    } catch {
      sha = "local"; // no git on PATH / not a checkout — the date alone still helps
    }
  }
  return `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · ${sha}`;
}

export default defineConfig({
  // Relative base so the build works on GitHub Pages project sites and any subfolder host.
  base: "./",
  define: { __BUILD_STAMP__: JSON.stringify(buildStamp()) },
});
