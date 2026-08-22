import { create } from "zustand";
import { RemoteClient, type HelloOk } from "@whalex/client-core";
import type { AgentEventEnvelope } from "@whalex/shared";
import { t } from "../i18n";
import { getToken, saveComputer, type PairedComputer } from "../lib/computers";
import { makeSocketFactory, probePublicUrl } from "../lib/socketFactory";

export type ConnectionPhase =
  | "disconnected"
  | "connecting"
  | "connected"
  /**
   * Tried long enough that something is actually wrong — usually the desktop
   * is asleep, or its address changed while the phone was away from the home
   * network. Retries continue underneath; the phase exists so the UI can stop
   * pretending and say what to do.
   */
  | "unreachable"
  /** The desktop refused our token — the pairing was revoked; re-scan the QR. */
  | "pairingRequired";

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
/** Attempts before the UI admits it isn't going to work on its own. */
const GIVE_UP_AFTER = 4;

interface ConnectionState {
  phase: ConnectionPhase;
  computer: PairedComputer | null;
  hello: HelloOk | null;
  client: RemoteClient | null;
  lastError: string | null;
  attempt: number;
  /** Session event fan-in; the session store registers itself here. */
  onEvent: ((env: AgentEventEnvelope) => void) | null;
  onAlert: ((env: AgentEventEnvelope) => void) | null;
  /**
   * Fired after every successful handshake. A new socket starts with no
   * subscriptions, so whoever holds an open session must re-subscribe and
   * re-hydrate — without this, a drop mid-turn froze the screen forever.
   */
  onConnected: (() => void) | null;
  /** Spend-limit / low-balance alert from the desktop; sticky until dismissed. */
  usageWarning: string | null;
  dismissUsageWarning(): void;

  connect(computer: PairedComputer): Promise<void>;
  disconnect(): void;
  /** Called by App on foreground/network-change to retry immediately. */
  kick(): void;
  /** Send the user back to the QR screen without dropping the stored token. */
  requestRepair(): void;
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  phase: "disconnected",
  computer: null,
  hello: null,
  client: null,
  lastError: null,
  attempt: 0,
  onEvent: null,
  onAlert: null,
  onConnected: null,
  usageWarning: null,

  dismissUsageWarning() {
    set({ usageWarning: null });
  },

  async connect(computer) {
    const gen = ++generation;
    if (retryTimer) clearTimeout(retryTimer);
    get().client?.close();
    set({ phase: "connecting", computer, lastError: null });

    const token = await getToken(computer.computerId);
    if (!token) {
      set({ phase: "pairingRequired", lastError: "no stored token" });
      return;
    }

    const attempt = get().attempt;
    const client = new RemoteClient({
      // Rotate through the known addresses across attempts.
      createSocket: makeSocketFactory(computer, token, attempt),
      client: { name: "WhaleX Android", platform: "android", appVersion: "0.1.0" },
      onEvent: (env) => get().onEvent?.(env),
      onAlert: (env) => get().onAlert?.(env),
      onUsageWarning: (w) => {
        // Rendered through the same i18n keys the desktop status bar uses.
        const params = { pct: Math.round(w.pct ?? 0), usd: w.usd.toFixed(2), limit: w.limit };
        set({ usageWarning: t(`usage.warn.${w.kind}`, params) });
      },
      onClose: () => {
        if (gen !== generation) return;
        scheduleRetry(set, get, gen);
      },
    });
    try {
      const hello = await client.connect();
      if (gen !== generation) {
        client.close();
        return;
      }
      set({ phase: "connected", client, hello, attempt: 0 });
      // A fresh socket knows nothing about sessions — let the session layer
      // re-subscribe and re-hydrate whatever it had open.
      get().onConnected?.();
      // The desktop's quick-tunnel address changes on every restart, so adopt
      // whatever it reports now — that's what keeps the next trip out working.
      const fresh: PairedComputer = {
        ...computer,
        ...(hello.publicUrl ? { publicUrl: hello.publicUrl } : {}),
        lastConnectedAt: Date.now(),
      };
      set({ computer: fresh });
      void saveComputer(fresh);
    } catch (err) {
      if (gen !== generation) return;
      const msg = err instanceof Error ? err.message : String(err);
      // A pre-upgrade 401 surfaces as a handshake failure mentioning 401.
      if (/401/.test(msg)) {
        set({ phase: "pairingRequired", client: null, lastError: msg });
        return;
      }
      set({ lastError: msg, client: null });
      // The desktop may have restarted onto a new tunnel address. If we can
      // still see it on this network, adopt the new address and retry at once
      // instead of backing off against a URL that is now permanently dead.
      const fresh = await probePublicUrl(computer);
      if (gen !== generation) return;
      if (fresh && fresh !== computer.publicUrl) {
        const updated = { ...computer, publicUrl: fresh };
        await saveComputer(updated);
        if (gen !== generation) return;
        set({ attempt: 0 });
        void get().connect(updated);
        return;
      }
      scheduleRetry(set, get, gen);
    }
  },

  disconnect() {
    generation++;
    if (retryTimer) clearTimeout(retryTimer);
    get().client?.close();
    set({ phase: "disconnected", client: null, hello: null, computer: null, attempt: 0 });
  },

  kick() {
    const { phase, computer } = get();
    if (computer && phase !== "connected" && phase !== "pairingRequired") {
      set({ attempt: 0 });
      void get().connect(computer);
    }
  },

  requestRepair() {
    generation++;
    if (retryTimer) clearTimeout(retryTimer);
    get().client?.close();
    // Re-scanning a known computer refreshes its address and keeps the token,
    // so this is a recovery path rather than starting over.
    set({ phase: "pairingRequired", client: null, attempt: 0 });
  },
}));

function scheduleRetry(
  set: (partial: Partial<ConnectionState>) => void,
  get: () => ConnectionState,
  gen: number,
): void {
  const attempt = get().attempt;
  const delay =
    (BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 30000) +
    Math.floor(Math.random() * 500);
  set({
    phase: attempt + 1 >= GIVE_UP_AFTER ? "unreachable" : "connecting",
    attempt: attempt + 1,
  });
  retryTimer = setTimeout(() => {
    if (gen !== generation) return;
    const computer = get().computer;
    if (computer) void get().connect(computer);
  }, delay);
}
