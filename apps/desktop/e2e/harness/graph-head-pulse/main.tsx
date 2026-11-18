import { createRoot } from "react-dom/client";
import { GraphRow, type GraphRowVM } from "../../../src/renderer/src/features/graph/GraphRow";
import { useHoverIntent } from "../../../src/renderer/src/lib/hoverIntent";
import "../../../src/renderer/src/styles/app.css";

const now = Date.parse("2026-11-18T15:00:00Z");
const noop = () => undefined;
const rows: GraphRowVM[] = [
  {
    commit: {
      hash: "ae023bf", shortHash: "ae023bf", parents: ["ec848da"],
      subject: "Update widget preview", authorName: "Sam Rivera",
      authorEmail: "sam@example.test", committedAt: "2026-11-18T14:00:00Z", isMerge: false
    },
    row: { lane: 2, top: [], bottom: [{ from: 2, to: 0 }] },
    refs: ["widget-preview"], remoteRefs: [], isHead: true, isHeadOnly: true,
    isMine: true, defaultBranch: "main"
  },
  {
    commit: {
      hash: "ec848da", shortHash: "ec848da", parents: [],
      subject: "Add sample widgets", authorName: "Avery Chen",
      authorEmail: "avery@example.test", committedAt: "2026-11-17T15:00:00Z", isMerge: false
    },
    row: { lane: 0, top: [{ from: 0, to: 0 }], bottom: [] },
    refs: ["main"], remoteRefs: [], isHead: false, isHeadOnly: false,
    isMine: false, defaultBranch: "main"
  }
];

function App() {
  const hoverIntent = useHoverIntent();
  return (
    <div className="graph-harness">
      {rows.map((vm) => (
        <GraphRow
          key={vm.commit.hash}
          vm={vm}
          laneCount={3}
          now={now}
          selected={false}
          focused={false}
          flashing={false}
          contextOpen={false}
          hoverIntent={hoverIntent}
          onOpen={noop}
          onShowContext={noop}
          onHideContext={noop}
          onFocusContext={() => false}
          onOpenContextMenu={noop}
        />
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
