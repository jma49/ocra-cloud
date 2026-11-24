import Search from "lucide-react/icons/search";
import { useEffect, useId, useRef, useState } from "react";
import { usePageCommands } from "../page-commands.js";
import type { GraphClient } from "./client.js";
import { FileMark, PathText, SymbolMark } from "./marks.js";
import type { GraphPlace } from "./place.js";
import type { Hit } from "./queries.js";

// Find a file or a symbol by name: a field over a list of matches, read
// from the worker as one types. `/` brings the field up from anywhere on
// the page.

const WAIT_MS = 80;

export function GraphSearch(props: { client: GraphClient; go: (to: GraphPlace) => void }) {
  const field = useRef<HTMLInputElement>(null);
  const list = useId();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [current, setCurrent] = useState(0);
  const [open, setOpen] = useState(false);
  usePageCommands("This code graph", [
    { label: "Find a file or symbol", key: "/", run: () => field.current?.focus() },
  ]);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      props.client.ask({ type: "search", query }).then(
        (found) => {
          if (!live) return;
          setHits(found);
          setCurrent(0);
        },
        () => live && setHits([]),
      );
    }, WAIT_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [props.client, query]);

  const pick = (hit: Hit | undefined) => {
    if (!hit) return;
    setOpen(false);
    setQuery("");
    field.current?.blur();
    props.go(
      hit.as === "file"
        ? { view: "focus", path: hit.path }
        : {
            view: "focus",
            path: hit.symbol.path,
            symbol: { name: hit.symbol.name, line: hit.symbol.start },
          },
    );
  };
  const shown = open && query.trim() !== "";
  return (
    <div className="graph-search">
      <Search size={14} aria-hidden="true" className="graph-search-icon" />
      <input
        ref={field}
        type="search"
        className="input"
        placeholder="Find a file or symbol"
        aria-label="Find a file or symbol"
        role="combobox"
        aria-expanded={shown}
        aria-controls={list}
        aria-activedescendant={shown && hits[current] ? `${list}-${current}` : undefined}
        aria-autocomplete="list"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setCurrent((c) => Math.min(hits.length - 1, c + 1));
          else if (e.key === "ArrowUp") setCurrent((c) => Math.max(0, c - 1));
          else if (e.key === "Enter") pick(hits[current]);
          else if (e.key === "Escape") {
            setOpen(false);
            field.current?.blur();
          } else return;
          e.preventDefault();
        }}
      />
      {shown && (
        <div className="graph-hits" id={list} role="listbox" aria-label="Matches">
          {hits.length === 0 ? (
            <p className="graph-hits-none">No file or symbol by that name.</p>
          ) : (
            hits.map((h, i) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the field's keys move through the options and pick one (aria-activedescendant)
              <div
                key={
                  h.as === "file" ? h.path : `${h.symbol.path}:${h.symbol.start}:${h.symbol.name}`
                }
                id={`${list}-${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === current}
                className={i === current ? "is-current" : ""}
                onPointerDown={(e) => e.preventDefault()}
                onPointerEnter={() => setCurrent(i)}
                onClick={() => pick(h)}
              >
                {h.as === "file" ? (
                  <>
                    <FileMark path={h.path} />
                    <PathText path={h.path} />
                    <span className="graph-row-meta">{h.defs.toLocaleString()} symbols</span>
                  </>
                ) : (
                  <>
                    <SymbolMark kind={h.symbol.kind} />
                    <span className="mono graph-row-name">{h.symbol.name}</span>
                    <span className="graph-hit-where">
                      <PathText path={`${h.symbol.path}:${h.symbol.start}`} />
                    </span>
                    <span className="graph-row-meta">
                      {h.uses === 0
                        ? "unused"
                        : `used in ${h.uses.toLocaleString()} file${h.uses === 1 ? "" : "s"}`}
                    </span>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
