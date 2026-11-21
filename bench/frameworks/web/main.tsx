import { useState } from "react";
import { createRoot } from "react-dom/client";

const scene = new URLSearchParams(location.search).get("scene") ?? (globalThis as { SCENE?: string }).SCENE ?? "empty";
const rows = Array.from({ length: 2000 }, (_, i) => i);

function Bench() {
  const [tick, setTick] = useState(0);
  const marker = tick === 0 ? "#ff00ff" : tick % 2 ? "#00ff00" : "#0000ff";
  return (
    <div className="app">
      <div className="top">
        <div className="marker" style={{ background: marker }} />
        <button className="update" onClick={() => setTick(t => t + 1)}>Update</button>
      </div>
      {scene === "list" ? (
        <div className="list">
          {rows.map(i => (
            <div className="row" key={i}>
              <span className="label">Record {i}: native layout and text {tick}</span>
              <button className="open">Open</button>
            </div>
          ))}
        </div>
      ) : <span>hi</span>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Bench />);
