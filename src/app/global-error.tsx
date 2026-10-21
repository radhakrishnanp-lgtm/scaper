"use client";

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", display: "grid", placeItems: "center", minHeight: "100vh", margin: 0, background: "#f6f5f2", color: "#1b1d1f" }}>
        <div style={{ textAlign: "center", maxWidth: 420, padding: 24 }}>
          <h1 style={{ fontSize: 22 }}>Scaper hit an unexpected error</h1>
          <p style={{ color: "#676b70", fontSize: 14 }}>Your data is safe. Reload the page, and check the terminal running Scaper if it keeps happening.</p>
          <button onClick={reset} style={{ marginTop: 16, height: 44, padding: "0 16px", borderRadius: 8, border: 0, background: "#0f766e", color: "#fff", fontWeight: 600, cursor: "pointer" }}>Reload</button>
        </div>
      </body>
    </html>
  );
}
