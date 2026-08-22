import { create } from "zustand";
import {
  emptyClientState,
  foldEnvelope,
  hydrateSession,
  type ClientSessionState,
  type FoldContext,
} from "@whalex/client-core";
import type { AgentEventEnvelope, ModelInfo, ReasoningEffort, SessionMeta } from "@whalex/shared";
import { useConnectionStore } from "./connectionStore";
import { notify } from "../lib/notify";

const foldCtx: FoldContext = {
  now: () => Date.now(),
  formatGoal: (ev) =>
    ev.done
      ? `Goal reached (${ev.iteration}/${ev.maxIterations})`
      : `Continuing toward goal (${ev.iteration}/${ev.maxIterations})`,
};

/** A working folder on the desktop, with the sessions that live in it. */
export interface Project {
  cwd: string;
  name: string;
  sessions: SessionMeta[];
  updatedAt: number;
}

interface MobileSessionState extends ClientSessionState {
  sessions: SessionMeta[];
  /** Folders the desktop has open or opened recently, newest work first. */
  projects: Project[];
  activeSessionId: string | null;
  cwd: string | null;
  model: string;
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "unrestricted";
  /** Models the desktop's active provider offers; empty until first fetch. */
  models: ModelInfo[];
  goalMode: boolean;
  /** Global tuning knob, mirrored from the desktop; "medium" until known. */
  effort: ReasoningEffort;
  /** Highest applied envelope seq; gaps force a fresh snapshot. */
  lastSeq: number;
  opening: boolean;

  refreshSessions(): Promise<void>;
  open(cwd: string, resumeSessionId?: string): Promise<void>;
  /** Start a fresh session in a project folder. */
  startNew(cwd: string): Promise<void>;
  setPermissionMode(mode: MobileSessionState["permissionMode"]): Promise<void>;
  refreshModels(): Promise<void>;
  setModel(model: string): Promise<void>;
  setGoalMode(on: boolean): Promise<void>;
  setSuperCode(on: boolean): Promise<void>;
  setEffort(effort: ReasoningEffort): Promise<void>;
  attachments: PendingAttachment[];
  addAttachment(a: PendingAttachment): void;
  removeAttachment(id: string): void;
  /** sessionId → count of approvals/questions waiting in OTHER sessions. */
  pendingBySession: Record<string, number>;
  /** Text waiting to be placed into the composer (steer-edit, plan revise). */
  draftSeed: string | null;
  setDraftSeed(text: string | null): void;
  /** Rewrite a still-queued steer message; false = the model already read it. */
  editPending(messageId: string, text: string): Promise<void>;
  /** Drop a still-queued steer message. */
  cancelPending(messageId: string): Promise<void>;
  clearPlanPending(): void;
  listCheckpoints(): Promise<
    Array<{ boundary: number; ts: number; label: string; fileChanges: number }>
  >;
  rewind(boundary: number): Promise<void>;
  /**
   * messageId → local uris of images that rode out with that message, so the
   * sent bubble shows the pictures and not just the vision text they became.
   * Session-local: a reload keeps the durable record (the description).
   */
  sentImages: Record<string, string[]>;
  /** Uploads a picked document to the desktop; returns its path there. */
  uploadFile(name: string, dataBase64: string): Promise<string>;
  closeSession(): void;
  send(text: string): Promise<void>;
  abort(): Promise<void>;
  respondPermission(id: string, allow: boolean, always?: boolean, rule?: string): Promise<void>;
  /** Slash commands the desktop offers for this cwd; loaded on open. */
  commands: import("@whalex/shared").SlashCommand[];
  runSessionCommand(command: string): Promise<{ handled: boolean; message?: string }>;
  answerQuestion(id: string, answer: string): Promise<void>;
}

/** Something picked on the phone, waiting to ride out with the next send. */
export interface PendingAttachment {
  id: string;
  kind: "image" | "file";
  name: string;
  /** Images: JPEG base64 (no data: prefix), described by vision at send. */
  dataBase64?: string;
  /** Files: already uploaded to the desktop; the agent reads this path. */
  path?: string;
  /** Local uri for the chip thumbnail. */
  uri?: string;
}

/** Envelopes arriving while session:start is in flight; applied after hydrate. */
let buffer: AgentEventEnvelope[] | null = null;

export const useMobileSession = create<MobileSessionState>((set, get) => {
  // Register as the connection's event sink once, at store creation.
  useConnectionStore.setState({
    // Every successful (re)connect re-opens the active session: a new socket
    // carries no subscriptions, so without this a drop mid-turn left the
    // phone frozen on "working" while the desktop had long finished.
    onConnected: () => {
      const { cwd, activeSessionId } = get();
      if (cwd && activeSessionId) void get().open(cwd, activeSessionId);
    },
    onEvent: (env) => handleEnvelope(env),
    onAlert: (env) => {
      const ev = env.event;
      // A session you are NOT looking at wants an answer — count it so the
      // session list can wear a badge instead of staying silent.
      if (ev.type === "permission-request" || ev.type === "question-request") {
        set((s) => ({
          pendingBySession: {
            ...s.pendingBySession,
            [env.sessionId]: (s.pendingBySession[env.sessionId] ?? 0) + 1,
          },
        }));
        notify(
          ev.type === "permission-request" ? "permission" : "question",
          get().sessions.find((m) => m.sessionId === env.sessionId)?.title,
        );
        return;
      }
      if (ev.type === "permission-resolved") {
        set((s) => ({
          pendingBySession: {
            ...s.pendingBySession,
            [env.sessionId]: Math.max(0, (s.pendingBySession[env.sessionId] ?? 0) - 1),
          },
        }));
        return;
      }
      // Titles apply to whichever session they name, active or not.
      if (ev.type === "session-title") {
        const title = ev.title;
        set((s) => ({
          sessions: s.sessions.map((m) => (m.sessionId === env.sessionId ? { ...m, title } : m)),
        }));
        return;
      }
      if (ev.type === "done" || ev.type === "error") {
        set((s) => ({ pendingBySession: { ...s.pendingBySession, [env.sessionId]: 0 } }));
        notify(
          ev.type === "done" ? "done" : "error",
          get().sessions.find((m) => m.sessionId === env.sessionId)?.title,
        );
        void get().refreshSessions();
      }
    },
  });

  function client() {
    const c = useConnectionStore.getState().client;
    if (!c) throw new Error("not connected");
    return c;
  }

  function handleEnvelope(env: AgentEventEnvelope): void {
    const s = get();
    // Titles apply to whichever session they name, active or not — and never
    // touch the transcript, so they skip the seq bookkeeping entirely.
    if (env.event.type === "session-title") {
      const title = env.event.title;
      set((st) => ({
        sessions: st.sessions.map((m) => (m.sessionId === env.sessionId ? { ...m, title } : m)),
      }));
      return;
    }
    if (env.sessionId !== s.activeSessionId) return;
    if (buffer) {
      buffer.push(env);
      return;
    }
    if (env.seq <= s.lastSeq) return; // replay from before the snapshot
    if (env.seq > s.lastSeq + 1) {
      // Gap — the stream is holey (reconnect missed events). Never render a
      // holey transcript; re-snapshot instead.
      const { cwd, activeSessionId } = s;
      if (cwd && activeSessionId) void get().open(cwd, activeSessionId);
      return;
    }
    const { state, signals } = foldEnvelope(clientSlice(s), env.event, foldCtx);
    set({ ...state, lastSeq: env.seq });
    // The phone in a pocket still learns the run ended or wants an answer.
    const evType = env.event.type;
    if (evType === "done") notify("done", sessionTitle(get(), env.sessionId));
    else if (evType === "error") notify("error", env.event.message);
    else if (evType === "permission-request") notify("permission");
    else if (evType === "question-request") notify("question");
    for (const sig of signals) {
      switch (sig.type) {
        case "turn-finished":
          // Keeps titles, timestamps and message counts honest on the list.
          void get().refreshSessions();
          break;
        case "supercode":
          // Mirror the desktop: SuperCode owns the model while it runs.
          if (sig.on) set({ model: "deepseek-v4-pro" });
          break;
        case "control":
          // Another client changed the chips — follow, don't lie.
          set({
            ...(sig.mode !== undefined
              ? { permissionMode: sig.mode as MobileSessionState["permissionMode"] }
              : {}),
            ...(sig.model !== undefined ? { model: sig.model } : {}),
            ...(sig.goalMode !== undefined ? { goalMode: sig.goalMode } : {}),
          });
          break;
        default:
          break;
      }
    }
  }

  return {
    ...emptyClientState(),
    sessions: [],
    projects: [],
    activeSessionId: null,
    cwd: null,
    model: "deepseek-v4-flash",
    permissionMode: "default",
    models: [],
    goalMode: false,
    effort: "medium",
    attachments: [],
    commands: [],
    sentImages: {},
    pendingBySession: {},
    draftSeed: null,
    lastSeq: 0,
    opening: false,

    async refreshSessions() {
      const c = client();
      const sessions = await c.invoke("session:list", {});
      // The desktop's sidebar groups by folder; mirror that, and fold in the
      // recent folders it knows about so a project with no session yet can
      // still be opened from the phone.
      let recent: string[] = [];
      try {
        const info = await c.invoke("remote:appInfo", undefined);
        recent = info.recentCwds;
        // The work-options sheet mirrors the desktop's global effort knob.
        if (info.reasoningEffort) set({ effort: info.reasoningEffort });
      } catch {
        // older desktop without the channel — sessions alone still group fine
      }
      const byCwd = new Map<string, Project>();
      const ensure = (cwd: string): Project => {
        const found = byCwd.get(cwd);
        if (found) return found;
        const created: Project = {
          cwd,
          name: cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd,
          sessions: [],
          updatedAt: 0,
        };
        byCwd.set(cwd, created);
        return created;
      };
      for (const cwd of recent) ensure(cwd);
      for (const s of sessions) {
        const p = ensure(s.cwd);
        p.sessions.push(s);
        p.updatedAt = Math.max(p.updatedAt, s.updatedAt);
      }
      for (const p of byCwd.values()) p.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      set({
        sessions,
        projects: [...byCwd.values()].sort((a, b) => b.updatedAt - a.updatedAt),
      });
    },

    async startNew(cwd) {
      await get().open(cwd);
      await get().refreshSessions();
    },

    async setPermissionMode(mode) {
      const id = get().activeSessionId;
      set({ permissionMode: mode });
      if (id) await client().invoke("session:setMode", { sessionId: id, mode });
    },

    async refreshModels() {
      // No providerId: the desktop answers for whatever provider is active.
      const models = await client().invoke("models:list", {});
      if (models.length > 0) set({ models });
    },

    async setModel(model) {
      const id = get().activeSessionId;
      set({ model });
      if (id) await client().invoke("session:setModel", { sessionId: id, model });
    },

    async setGoalMode(on) {
      const id = get().activeSessionId;
      set({ goalMode: on });
      if (id) await client().invoke("session:setGoalMode", { sessionId: id, on });
    },

    async setSuperCode(on) {
      const id = get().activeSessionId;
      // The authoritative flip comes back through the supercode envelope;
      // setting it here just keeps the toggle from feeling laggy.
      set({ superCode: on });
      if (id) {
        await client().invoke("session:command", {
          sessionId: id,
          command: on ? "supercode-on" : "supercode-off",
        });
      }
    },

    async setEffort(effort) {
      set({ effort });
      await client().invoke("app:setEffort", { effort });
    },

    addAttachment(a) {
      set({ attachments: [...get().attachments, a] });
    },

    setDraftSeed(text) {
      set({ draftSeed: text });
    },

    async editPending(messageId, text) {
      const id = get().activeSessionId;
      if (!id) return;
      const res = await client().invoke("session:steerEdit", { sessionId: id, messageId, text });
      set((s) => ({
        transcript: s.transcript.map((t) =>
          t.kind === "user" && t.id === messageId
            ? res.ok
              ? { ...t, text }
              : // Lost the race — the model already has the original text.
                { ...t, delivery: "read" as const }
            : t,
        ),
      }));
    },

    async cancelPending(messageId) {
      const id = get().activeSessionId;
      if (!id) return;
      const res = await client().invoke("session:steerCancel", { sessionId: id, messageId });
      set((s) => ({
        transcript: res.ok
          ? s.transcript.filter((t) => !(t.kind === "user" && t.id === messageId))
          : s.transcript.map((t) =>
              t.kind === "user" && t.id === messageId ? { ...t, delivery: "read" as const } : t,
            ),
      }));
    },

    clearPlanPending() {
      set({ planPending: false });
    },

    async listCheckpoints() {
      const id = get().activeSessionId;
      if (!id) return [];
      return client().invoke("checkpoint:list", { sessionId: id });
    },

    async rewind(boundary) {
      const id = get().activeSessionId;
      if (!id) return;
      const res = await client().invoke("checkpoint:rewind", { sessionId: id, boundary });
      set({ transcript: res.transcript, planPending: false });
    },

    removeAttachment(id) {
      set({ attachments: get().attachments.filter((a) => a.id !== id) });
    },

    async uploadFile(name, dataBase64) {
      const res = await client().invoke("files:upload", { name, dataBase64 });
      return res.path;
    },

    async open(cwd, resumeSessionId) {
      const c = client();
      set({ opening: true, activeSessionId: resumeSessionId ?? null, cwd });
      // Subscribe FIRST and buffer, so nothing falls between snapshot and stream.
      if (resumeSessionId) c.subscribe([resumeSessionId]);
      buffer = [];
      try {
        const res = await c.invoke("session:start", { cwd, resumeSessionId });
        c.subscribe([res.sessionId]);
        const snapshotSeq = res.seq ?? 0;
        const hydrated = hydrateSession(res, foldCtx);
        set({
          ...hydrated,
          activeSessionId: res.sessionId,
          cwd: res.cwd,
          model: res.model ?? get().model,
          permissionMode: res.permissionMode ?? get().permissionMode,
          goalMode: res.goalMode ?? false,
          lastSeq: snapshotSeq,
          opening: false,
          turnStartedAt: null,
          lastTurnMs: null,
        });
        // The slash suggestions mirror what the desktop offers here.
        void c
          .invoke("commands:list", { cwd: res.cwd })
          .then((commands) => set({ commands }))
          .catch(() => undefined);
        const pending = buffer;
        buffer = null;
        for (const env of pending) {
          if (env.sessionId === res.sessionId && env.seq > get().lastSeq) {
            const { state } = foldEnvelope(clientSlice(get()), env.event, foldCtx);
            set({ ...state, lastSeq: env.seq });
          }
        }
      } catch (err) {
        buffer = null;
        set({ opening: false });
        throw err;
      }
    },

    closeSession() {
      const c = useConnectionStore.getState().client;
      c?.subscribe([]);
      set({ ...emptyClientState(), activeSessionId: null, cwd: null, lastSeq: 0 });
    },

    async send(text) {
      const { activeSessionId, model, status, attachments } = get();
      if (!activeSessionId) return;
      const steering = status !== "idle";
      const messageId = `mob-${Date.now()}`;
      set((s) => ({
        transcript: [
          ...s.transcript,
          {
            kind: "user" as const,
            id: messageId,
            text,
            ts: Date.now(),
            ...(steering ? { delivery: "pending" as const } : {}),
          },
        ],
        attachments: [],
        ...(() => {
          const uris = attachments.filter((a) => a.kind === "image" && a.uri).map((a) => a.uri!);
          return uris.length > 0
            ? { sentImages: { ...s.sentImages, [messageId]: uris } }
            : {};
        })(),
        ...(steering ? {} : { status: "thinking" as const, turnStartedAt: Date.now() }),
      }));

      // Same pipeline as the desktop composer: documents ride as @path
      // mentions (they already live on the desktop via files:upload), and
      // images pass through the vision sidecar to become text the model can
      // actually read.
      let finalText = text;
      const files = attachments.filter((a) => a.kind === "file" && a.path);
      if (files.length > 0) {
        const mentions = files.map((f) => `@${f.path}`).join(" ");
        finalText = finalText ? `${finalText}\n\n${mentions}` : mentions;
      }
      const images = attachments.filter((a) => a.kind === "image" && a.dataBase64);
      for (const img of images) {
        try {
          const res = await client().invoke("vision:describe", {
            imageDataUrl: `data:image/jpeg;base64,${img.dataBase64}`,
            question: text || undefined,
          });
          finalText += res.configured
            ? `\n\n[Attached image: ${img.name}]\n${res.ok ? (res.description ?? "") : `(analysis failed: ${res.error ?? "unknown"})`}`
            : "\n\n[An image was attached but no vision model is configured on the desktop.]";
        } catch (err) {
          finalText += `\n\n[Image analysis failed: ${err instanceof Error ? err.message : String(err)}]`;
        }
      }

      try {
        await client().invoke("session:send", {
          sessionId: activeSessionId,
          text: finalText,
          model,
          messageId,
        });
      } catch {
        // Same quiet-dead-socket story as abort: the bubble was drawn but the
        // message never left, and "Unread" forever looked like the agent
        // ignoring you. Kick the connection so the reconnect banner shows;
        // the still-pending bubble can be long-pressed and re-sent.
        useConnectionStore.getState().kick();
        set((s) => ({
          transcript: s.transcript.map((tr) =>
            tr.kind === "user" && tr.id === messageId
              ? { ...tr, delivery: "pending" as const }
              : tr,
          ),
        }));
      }
    },

    async runSessionCommand(command) {
      const id = get().activeSessionId;
      if (!id) return { handled: false };
      return client().invoke("session:command", { sessionId: id, command });
    },

    async abort() {
      const id = get().activeSessionId;
      if (!id) return;
      try {
        await client().invoke("session:abort", { sessionId: id });
      } catch {
        // The most common reason a Stop tap goes nowhere on a phone: the
        // socket died quietly (LTE handover, sleep) and the invoke never
        // left. Kick the connection so the reconnect banner appears and the
        // retry has a live socket — silence here read as "stop is broken".
        useConnectionStore.getState().kick();
      }
    },

    async respondPermission(id, allow, always = false, chosenRule) {
      // "Always" persists a suggested rule — the caller may pick which one,
      // like the desktop's rule dropdown; the first is the default.
      const rule =
        chosenRule ?? get().pendingPermissions.find((p) => p.id === id)?.suggestedRules[0];
      set((s) => ({ pendingPermissions: s.pendingPermissions.filter((p) => p.id !== id) }));
      await client().invoke("permission:respond", {
        id,
        behavior: allow ? "allow" : "deny",
        scope: always ? "always" : "once",
        ...(always && rule ? { rule } : {}),
      });
    },

    async answerQuestion(id, answer) {
      set({ pendingQuestion: null });
      await client().invoke("question:respond", { id, answer });
    },
  };
});

function sessionTitle(s: MobileSessionState, sessionId: string): string | undefined {
  return s.sessions.find((m) => m.sessionId === sessionId)?.title || undefined;
}

function clientSlice(s: MobileSessionState): ClientSessionState {
  return {
    transcript: s.transcript,
    status: s.status,
    usage: s.usage,
    todos: s.todos,
    pendingPermissions: s.pendingPermissions,
    pendingQuestion: s.pendingQuestion,
    planPending: s.planPending,
    lastError: s.lastError,
    artifacts: s.artifacts,
    subagents: s.subagents,
    workflows: s.workflows,
    turnStartedAt: s.turnStartedAt,
    lastTurnMs: s.lastTurnMs,
    superCode: s.superCode,
  };
}
