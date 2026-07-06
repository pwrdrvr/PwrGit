// Placeholder shell for the walking skeleton. Replaced by the three-pane
// layout (tokens + titlebar + panes) in U4.
export function App() {
  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0a0908",
        color: "#f5efe3",
        fontFamily: "system-ui, sans-serif"
      }}
    >
      <div style={{ textAlign: "center" }}>
        <div style={{ fontWeight: 700, fontSize: 22, color: "#fda984" }}>PwrGit</div>
        <div style={{ marginTop: 8, fontSize: 13, color: "#8a8275" }}>
          walking skeleton
        </div>
      </div>
    </div>
  );
}
