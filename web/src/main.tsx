import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

type Health = "checking" | "ok" | "down";

function App() {
  const [health, setHealth] = useState<Health>("checking");
  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json() as Promise<{ ok?: boolean }>)
      .then((body) => setHealth(body.ok ? "ok" : "down"))
      .catch(() => setHealth("down"));
  }, []);
  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 640,
        margin: "4rem auto",
        padding: "0 16px",
      }}
    >
      <h1>ocra Cloud</h1>
      <p>Development build. Sign-in, keys and review history are coming.</p>
      <p>API: {health}</p>
    </main>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
