/**
 * SHA-256 hex of the passcode required to open the deployed app (one-time per
 * browser). Set to "" to disable the gate. To change the passcode:
 *
 *   printf %s "your-new-passcode" | sha256sum
 *
 * then paste the hash here and push. Already-unlocked browsers re-lock
 * automatically because the stored unlock is tied to this hash.
 *
 * Note: this is a deterrent, not real security — the repo (and thus this
 * hash) is public. Nothing sensitive ships in the build; API keys and Trakt
 * tokens only ever live in each browser's localStorage.
 */
export const PASSCODE_SHA256 = "ffb14d3595e3f10df804a3ed5177c6caaa531e395884062da6a6e4f76f6e7057";
