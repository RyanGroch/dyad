// DEBUG: remove before commit — native crash-test buttons.
// Delete this file and its import/usage in src/app/layout.tsx.

const buttonStyle: React.CSSProperties = {
  background: "#b91c1c",
  color: "white",
  fontSize: 11,
  padding: "4px 8px",
  borderRadius: 4,
  border: "none",
  cursor: "pointer",
};

export function DebugCrashButtons() {
  const trigger = (
    kind: "main" | "v8-oom" | "renderer" | "gpu" | "open-dumps",
  ) => {
    (
      window as unknown as {
        electron?: {
          ipcRenderer?: { invoke?: (c: string, k: string) => void };
        };
      }
    ).electron?.ipcRenderer?.invoke?.("debug:native-crash", kind);
  };

  return (
    <div
      style={{
        position: "fixed",
        bottom: 8,
        right: 8,
        zIndex: 99999,
        display: "flex",
        gap: 6,
      }}
    >
      <button style={buttonStyle} onClick={() => trigger("main")}>
        Crash main
      </button>
      <button style={buttonStyle} onClick={() => trigger("v8-oom")}>
        V8 OOM
      </button>
      <button style={buttonStyle} onClick={() => trigger("renderer")}>
        Crash renderer
      </button>
      <button style={buttonStyle} onClick={() => trigger("gpu")}>
        Crash GPU
      </button>
      <button style={buttonStyle} onClick={() => trigger("open-dumps")}>
        Open dumps
      </button>
    </div>
  );
}
