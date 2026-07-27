"use client";

import { useEffect, useRef, useState } from "react";

export type AddressSuggestion = { description: string; placeId: string };

/**
 * Debounced Google-Places address suggestions via our /api/places proxy
 * (vault key stays server-side). One session token per typing session so
 * Google bills the whole keystroke burst as a single autocomplete session.
 * Fail-soft: any error → empty list; typing by hand always works.
 */
export function useAddressSuggestions(query: string, enabled = true) {
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const sessionRef = useRef<string>("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled) {
      setSuggestions([]);
      return;
    }
    const q = query.trim();
    if (q.length < 4) {
      setSuggestions([]);
      return;
    }
    if (!sessionRef.current) {
      sessionRef.current =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    }
    const t = setTimeout(() => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      fetch(
        `/api/places?q=${encodeURIComponent(q)}&session=${sessionRef.current}`,
        { signal: ctrl.signal },
      )
        .then((r) => (r.ok ? r.json() : { predictions: [] }))
        .then((d: { predictions?: AddressSuggestion[] }) =>
          setSuggestions(Array.isArray(d.predictions) ? d.predictions : []),
        )
        .catch(() => {
          /* aborted or offline — keep whatever is shown */
        });
    }, 300);
    return () => clearTimeout(t);
  }, [query, enabled]);

  /** Call after a suggestion is picked (or the field is submitted) so the
   *  next typing burst starts a fresh Google billing session. */
  const endSession = () => {
    sessionRef.current = "";
    setSuggestions([]);
  };

  return { suggestions, endSession };
}
