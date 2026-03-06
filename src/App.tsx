import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import TerminalView from "./Terminal";
import "./App.css";

interface Session {
  id: string;
  name: string;
  path: string;
  mode: string;
  shellId?: string;
  splitDir: "horizontal" | "vertical";
}

interface HistoryEntry {
  name: string;
  path: string;
  mode: string;
  last_used: number;
}

// "working" -> "done" (needs ack) -> click -> "idle" (green)
type SessionStatus = "working" | "done" | "idle" | "ended";
type LaunchStep = "idle" | "pick-mode";

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({});
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [launchStep, setLaunchStep] = useState<LaunchStep>("idle");
  const [pendingPath, setPendingPath] = useState<string>("");
  const idleTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const burstCounters = useRef<Record<string, { count: number; window: ReturnType<typeof setTimeout> | null }>>({});
  const unlisteners = useRef<Record<string, (() => void)[]>>({});
  const wasWorking = useRef<Record<string, boolean>>({});

  useEffect(() => {
    invoke<HistoryEntry[]>("get_history").then(setHistory);
  }, []);

  const refreshHistory = () => {
    invoke<HistoryEntry[]>("get_history").then(setHistory);
  };

  const trackSession = useCallback((sessionId: string) => {
    setStatuses((prev) => ({ ...prev, [sessionId]: "idle" }));
    burstCounters.current[sessionId] = { count: 0, window: null };
    wasWorking.current[sessionId] = false;

    const unData = listen<string>(`pty-data-${sessionId}`, () => {
      const burst = burstCounters.current[sessionId];
      if (!burst) return;
      burst.count++;
      if (!burst.window) {
        burst.window = setTimeout(() => {
          if (burst.count >= 3) {
            wasWorking.current[sessionId] = true;
            setStatuses((prev) => (prev[sessionId] === "ended" ? prev : { ...prev, [sessionId]: "working" }));
          }
          burst.count = 0;
          burst.window = null;
        }, 500);
      }
      clearTimeout(idleTimers.current[sessionId]);
      idleTimers.current[sessionId] = setTimeout(() => {
        setStatuses((prev) => {
          if (prev[sessionId] === "ended") return prev;
          // If was working, go to "done" (needs ack), otherwise stay idle
          if (wasWorking.current[sessionId]) {
            wasWorking.current[sessionId] = false;
            return { ...prev, [sessionId]: "done" };
          }
          return { ...prev, [sessionId]: "idle" };
        });
      }, 3000);
    });

    const unExit = listen(`pty-exit-${sessionId}`, () => {
      clearTimeout(idleTimers.current[sessionId]);
      if (burstCounters.current[sessionId]?.window) {
        clearTimeout(burstCounters.current[sessionId].window!);
      }
      setStatuses((prev) => ({ ...prev, [sessionId]: "ended" }));
    });

    Promise.all([unData, unExit]).then(([a, b]) => {
      unlisteners.current[sessionId] = [a, b];
    });
  }, []);

  const cleanupPty = useCallback((ptyId: string) => {
    clearTimeout(idleTimers.current[ptyId]);
    delete idleTimers.current[ptyId];
    if (burstCounters.current[ptyId]?.window) {
      clearTimeout(burstCounters.current[ptyId].window!);
    }
    delete burstCounters.current[ptyId];
    delete wasWorking.current[ptyId];
    unlisteners.current[ptyId]?.forEach((fn) => fn());
    delete unlisteners.current[ptyId];
    setStatuses((prev) => {
      const next = { ...prev };
      delete next[ptyId];
      return next;
    });
  }, []);

  const ackSession = (sessionId: string) => {
    setStatuses((prev) => {
      if (prev[sessionId] === "done") {
        return { ...prev, [sessionId]: "idle" };
      }
      return prev;
    });
  };

  const startNew = async () => {
    const folder = await invoke<string | null>("pick_folder");
    if (folder) {
      setPendingPath(folder);
      setLaunchStep("pick-mode");
    }
  };

  const launchWithMode = async (mode: string) => {
    setLaunchStep("idle");
    try {
      const res = await invoke<{ id: string; name: string; path: string; mode: string }>(
        "spawn_claude", { path: pendingPath, mode }
      );
      const session: Session = { ...res, shellId: undefined, splitDir: "horizontal" };
      setSessions((prev) => [...prev, session]);
      setActiveId(session.id);
      trackSession(session.id);
      refreshHistory();
    } catch (e) {
      alert(`Failed to launch: ${e}`);
    }
  };

  const toggleShell = async (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;

    if (session.shellId) {
      invoke("kill_session", { sessionId: session.shellId });
      cleanupPty(session.shellId);
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, shellId: undefined } : s))
      );
    } else {
      try {
        const res = await invoke<{ id: string }>("spawn_shell", { path: session.path });
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, shellId: res.id } : s))
        );
        trackSession(res.id);
      } catch (e) {
        alert(`Failed to open terminal: ${e}`);
      }
    }
  };

  const toggleSplitDir = (sessionId: string) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? { ...s, splitDir: s.splitDir === "horizontal" ? "vertical" : "horizontal" }
          : s
      )
    );
  };

  const launchFromHistory = (entry: HistoryEntry) => {
    const existing = sessions.find((s) => s.path === entry.path);
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    setPendingPath(entry.path);
    setLaunchStep("pick-mode");
  };

  const deleteHistory = async (path: string) => {
    await invoke("remove_history_entry", { path });
    refreshHistory();
  };

  const closeSession = useCallback((sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    invoke("kill_session", { sessionId });
    cleanupPty(sessionId);
    if (session?.shellId) {
      invoke("kill_session", { sessionId: session.shellId });
      cleanupPty(session.shellId);
    }
    setSessions((prev) => {
      const remaining = prev.filter((s) => s.id !== sessionId);
      setActiveId((current) => {
        if (current === sessionId) {
          return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
        }
        return current;
      });
      return remaining;
    });
  }, [sessions, cleanupPty]);

  const hasSessions = sessions.length > 0;
  const activeSession = sessions.find((s) => s.id === activeId);
  const activeSessionPaths = new Set(sessions.map((s) => s.path));

  const StatusIcon = ({ status, onClick }: { status: SessionStatus | undefined; onClick?: () => void }) => {
    if (status === "ended") {
      return (
        <div className="status-icon ended" title="Session ended">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </div>
      );
    }
    if (status === "done") {
      return (
        <div className="status-icon done" title="Task finished — click to acknowledge" onClick={(e) => { e.stopPropagation(); onClick?.(); }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
          </svg>
        </div>
      );
    }
    if (status === "idle") {
      return (
        <div className="status-icon idle" title="Idle — ready">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
      );
    }
    return (
      <div className="status-icon working" title="Working...">
        <div className="spinner" />
      </div>
    );
  };

  const timeAgo = (ts: number) => {
    const diff = Math.floor(Date.now() / 1000) - ts;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  };

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <span className="logo-text">CLAUDE HUB</span>
        </div>

        <div className="session-list">
          {sessions.length > 0 && <div className="section-label">Active</div>}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-item${s.id === activeId ? " active" : ""}${statuses[s.id] === "done" ? " has-notification" : ""}`}
              onClick={() => {
                setActiveId(s.id);
                ackSession(s.id);
              }}
            >
              <StatusIcon status={statuses[s.id]} onClick={() => ackSession(s.id)} />
              <div className="session-info">
                <div className="session-top">
                  <span className="session-name">{s.name}</span>
                  <span className="session-mode">
                    {s.mode === "dangerously-skip-permissions" ? "yolo" : "safe"}
                  </span>
                </div>
                <span className="session-path">{s.path}</span>
              </div>
              <button
                className="session-close"
                onClick={(e) => { e.stopPropagation(); closeSession(s.id); }}
              >
                &times;
              </button>
            </div>
          ))}

          {history.filter((h) => !activeSessionPaths.has(h.path)).length > 0 && (
            <>
              <div className="section-label">Recent</div>
              {history.filter((h) => !activeSessionPaths.has(h.path)).map((h) => (
                <div key={h.path} className="session-item history-item" onClick={() => launchFromHistory(h)}>
                  <div className="status-icon history" title="Click to relaunch">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                    </svg>
                  </div>
                  <div className="session-info">
                    <div className="session-top">
                      <span className="session-name">{h.name}</span>
                      <span className="session-time">{timeAgo(h.last_used)}</span>
                    </div>
                    <span className="session-path">{h.path}</span>
                  </div>
                  <button className="session-close" title="Remove from history"
                    onClick={(e) => { e.stopPropagation(); deleteHistory(h.path); }}>
                    &times;
                  </button>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="sidebar-footer">
          <button className="new-session-btn" onClick={startNew}>
            + New session
          </button>
        </div>
      </div>

      {/* Main */}
      <div className="main-content">
        {hasSessions ? (
          <>
            <div className="toolbar">
              <span className="toolbar-title">{activeSession?.name}</span>
              <div className="toolbar-actions">
                {activeSession?.shellId && (
                  <button
                    className="toolbar-btn"
                    onClick={() => activeId && toggleSplitDir(activeId)}
                    title={activeSession.splitDir === "horizontal" ? "Switch to vertical split" : "Switch to horizontal split"}
                  >
                    {activeSession.splitDir === "horizontal" ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/>
                      </svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/>
                      </svg>
                    )}
                  </button>
                )}
                <button
                  className={`toolbar-btn${activeSession?.shellId ? " active" : ""}`}
                  onClick={() => activeId && toggleShell(activeId)}
                  title={activeSession?.shellId ? "Close terminal" : "Open terminal"}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
                  </svg>
                  Terminal
                </button>
              </div>
            </div>

            <div className={`panes-container${activeSession?.shellId ? ` split-${activeSession.splitDir}` : ""}`}>
              <div className={`pane claude-pane${activeSession?.shellId ? " with-shell" : ""}`}>
                {sessions.map((s) => (
                  <TerminalView
                    key={s.id}
                    sessionId={s.id}
                    visible={s.id === activeId}
                    onExit={() => {}}
                  />
                ))}
              </div>

              {activeSession?.shellId && (
                <div className="pane shell-pane">
                  <TerminalView
                    key={activeSession.shellId}
                    sessionId={activeSession.shellId}
                    visible={true}
                    onExit={() => {}}
                  />
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="welcome-screen">
            <div className="welcome-title">CLAUDE HUB</div>
            <div className="welcome-subtitle">Launch and manage Claude Code sessions</div>
            <button className="welcome-btn" onClick={startNew}>
              + New session
            </button>
          </div>
        )}
      </div>

      {/* Mode picker modal */}
      {launchStep === "pick-mode" && (
        <div className="modal-overlay" onClick={() => setLaunchStep("idle")}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Launch mode</h2>
            <p className="modal-path">{pendingPath}</p>

            <div className="mode-cards">
              <div className="mode-card" onClick={() => launchWithMode("normal")}>
                <div className="mode-icon safe-icon">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  </svg>
                </div>
                <div className="mode-label">Normal</div>
                <div className="mode-desc">Asks before risky actions</div>
              </div>

              <div className="mode-card danger" onClick={() => launchWithMode("dangerously-skip-permissions")}>
                <div className="mode-icon danger-icon">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
                  </svg>
                </div>
                <div className="mode-label">YOLO mode</div>
                <div className="mode-desc">Skip all permission prompts</div>
              </div>
            </div>

            <button className="btn btn-secondary modal-cancel" onClick={() => setLaunchStep("idle")}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
