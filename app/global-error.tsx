"use client";

import { useEffect } from "react";

/**
 * App-router global error boundary. Triggered only when a render throws
 * outside any nested route's `error.tsx` — basically when something
 * blows up in app/layout.tsx or the root page. Shows the message + digest
 * so the user can copy them into a bug report instead of staring at a
 * blank 500 page.
 *
 * Renders its own <html> + <body> because this boundary replaces the
 * root layout (it has to — the root layout is what failed).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[global-error boundary]", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
          margin: 0,
          minHeight: "100vh",
          background:
            "linear-gradient(135deg, #f8fafc 0%, #ffffff 50%, #f1f5f9 100%)",
          color: "#0f172a",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "1.5rem",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: 560,
            background: "white",
            border: "1px solid #e2e8f0",
            borderRadius: 16,
            boxShadow:
              "0 10px 30px -10px rgba(15,23,42,0.1), 0 2px 6px -2px rgba(15,23,42,0.06)",
            padding: 32,
          }}
        >
          <h1
            style={{
              fontSize: 22,
              fontWeight: 600,
              margin: 0,
              letterSpacing: "-0.01em",
            }}
          >
            Something broke loading this page
          </h1>
          <p
            style={{
              marginTop: 6,
              marginBottom: 18,
              color: "#64748b",
              fontSize: 14,
              lineHeight: 1.45,
            }}
          >
            Screenshot the details below if you need to file a bug.
          </p>

          <div
            style={{
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: 12,
              padding: 16,
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            <div
              style={{
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "#64748b",
                fontWeight: 600,
              }}
            >
              Message
            </div>
            <div
              style={{
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                color: "#0f172a",
                marginTop: 4,
                wordBreak: "break-word",
              }}
            >
              {error.message || "(empty)"}
            </div>
            {error.digest && (
              <>
                <div
                  style={{
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    color: "#64748b",
                    fontWeight: 600,
                    marginTop: 12,
                  }}
                >
                  Digest
                </div>
                <div
                  style={{
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    color: "#0f172a",
                    marginTop: 4,
                  }}
                >
                  {error.digest}
                </div>
                <p style={{ marginTop: 6, marginBottom: 0, color: "#64748b" }}>
                  Look this up in Vercel → Logs to see the full server-side
                  stack.
                </p>
              </>
            )}
          </div>

          <button
            onClick={reset}
            style={{
              marginTop: 20,
              width: "100%",
              padding: "10px 14px",
              borderRadius: 12,
              border: "none",
              background: "#059669",
              color: "white",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
