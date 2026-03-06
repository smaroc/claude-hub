import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";

interface TerminalViewProps {
  sessionId: string;
  visible: boolean;
  onExit: () => void;
}

export default function TerminalView({ sessionId, visible, onExit }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // Initialize terminal once
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', Menlo, monospace",
      theme: {
        background: "#0d0d0d",
        foreground: "#e0e0e0",
        cursor: "#a78bfa",
        selectionBackground: "#a78bfa40",
        black: "#0d0d0d",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#a78bfa",
        cyan: "#06b6d4",
        white: "#e0e0e0",
        brightBlack: "#555555",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#facc15",
        brightBlue: "#60a5fa",
        brightMagenta: "#c4b5fd",
        brightCyan: "#22d3ee",
        brightWhite: "#ffffff",
      },
      allowProposedApi: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(el);

    termRef.current = term;
    fitRef.current = fitAddon;

    // Initial fit
    setTimeout(() => {
      fitAddon.fit();
      invoke("resize_pty", { sessionId, rows: term.rows, cols: term.cols }).catch(() => {});
    }, 50);

    // Send input to PTY
    term.onData((data) => {
      invoke("write_pty", { sessionId, input: data }).catch(() => {});
    });

    // Receive PTY output
    const unData = listen<string>(`pty-data-${sessionId}`, (e) => {
      term.write(e.payload);
    });

    const unExit = listen(`pty-exit-${sessionId}`, () => {
      term.write("\r\n\x1b[90m[Session ended]\x1b[0m\r\n");
      onExit();
    });

    // Resize observer
    const ro = new ResizeObserver(() => {
      setTimeout(() => {
        try {
          fitAddon.fit();
          invoke("resize_pty", { sessionId, rows: term.rows, cols: term.cols }).catch(() => {});
        } catch {}
      }, 0);
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      unData.then((fn) => fn());
      unExit.then((fn) => fn());
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  // Re-fit on visibility change
  useEffect(() => {
    if (visible && fitRef.current && termRef.current) {
      setTimeout(() => {
        fitRef.current?.fit();
        const t = termRef.current;
        if (t) {
          invoke("resize_pty", { sessionId, rows: t.rows, cols: t.cols }).catch(() => {});
        }
      }, 10);
    }
  }, [visible, sessionId]);

  return (
    <div className={`terminal-wrapper${visible ? "" : " hidden"}`}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
