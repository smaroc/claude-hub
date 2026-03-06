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
}

// "working" = PTY actively outputting, "idle" = no output for 2s, "ended" = session exited
type SessionStatus = "working" | "idle" | "ended";

type LaunchStep = "idle" | "pick-mode";

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({});
  const [launchStep, setLaunchStep] = useState<LaunchStep>("idle");
  const [pendingPath, setPendingPath] = useState<string>("");
  const idleTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const burstCounters = useRef<Record<string, { count: number; window: ReturnType<typeof setTimeout> | null }>>({});
  const unlisteners = useRef<Record<string, (() => void)[]>>({});

  const trackSession = useCallback((sessionId: string) => {
    setStatuses((prev) => ({ ...prev, [sessionId]: "idle" }));
    burstCounters.current[sessionId] = { count: 0, window: null };

    const unData = listen<string>(`pty-data-${sessionId}`, () => {
      const burst = burstCounters.current[sessionId];
      if (!burst) return;

      burst.count++;

      // Start a 500ms window to count data events
      if (!burst.window) {
        burst.window = setTimeout(() => {
          // 3+ data events in 500ms = sustained output = Claude is working
          if (burst.count >= 3) {
            setStatuses((prev) => (prev[sessionId] === "ended" ? prev : { ...prev, [sessionId]: "working" }));
          }
          burst.count = 0;
          burst.window = null;
        }, 500);
      }

      // Reset idle timer on every output
      clearTimeout(idleTimers.current[sessionId]);
      idleTimers.current[sessionId] = setTimeout(() => {
        setStatuses((prev) => (prev[sessionId] === "ended" ? prev : { ...prev, [sessionId]: "idle" }));
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

  const cleanupSession = useCallback((sessionId: string) => {
    clearTimeout(idleTimers.current[sessionId]);
    delete idleTimers.current[sessionId];
    if (burstCounters.current[sessionId]?.window) {
      clearTimeout(burstCounters.current[sessionId].window!);
    }
    delete burstCounters.current[sessionId];
    unlisteners.current[sessionId]?.forEach((fn) => fn());
    delete unlisteners.current[sessionId];
    setStatuses((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

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
      const session = await invoke<Session>("spawn_claude", {
        path: pendingPath,
        mode,
      });
      setSessions((prev) => [...prev, session]);
      setActiveId(session.id);
      trackSession(session.id);
    } catch (e) {
      alert(`Failed to launch: ${e}`);
    }
  };

  const closeSession = useCallback((sessionId: string) => {
    invoke("kill_session", { sessionId });
    cleanupSession(sessionId);
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
  }, [cleanupSession]);

  const hasSessions = sessions.length > 0;

  const StatusIcon = ({ status }: { status: SessionStatus | undefined }) => {
    if (status === "ended") {
      return (
        <div className="status-icon ended" title="Session ended">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </div>
      );
    }
    if (status === "idle") {
      return (
        <div className="status-icon idle" title="Idle - ready">
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

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <span className="logo-text">CLAUDE HUB</span>
        </div>

        <div className="session-list">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-item${s.id === activeId ? " active" : ""}`}
              onClick={() => setActiveId(s.id)}
            >
              <StatusIcon status={statuses[s.id]} />
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
                onClick={(e) => {
                  e.stopPropagation();
                  closeSession(s.id);
                }}
              >
                &times;
              </button>
            </div>
          ))}
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
          <div className="terminal-container">
            {sessions.map((s) => (
              <TerminalView
                key={s.id}
                sessionId={s.id}
                visible={s.id === activeId}
                onExit={() => {}}
              />
            ))}
          </div>
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
