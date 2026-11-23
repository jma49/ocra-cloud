import ChevronDown from "lucide-react/icons/chevron-down";
import ChevronUp from "lucide-react/icons/chevron-up";
import Search from "lucide-react/icons/search";
import X from "lucide-react/icons/x";
import { MAX_MATCHES } from "./diff-search.js";
import type { useDiffSearch } from "./use-diff-search.js";

/** The find field over the diffs: how many matches, and a step to each. */
export function SearchBar(props: { search: ReturnType<typeof useDiffSearch> }) {
  const { search } = props;
  if (!search.open) return null;
  const said =
    search.query === ""
      ? ""
      : search.count === 0
        ? "No matches"
        : `${search.at + 1} of ${search.count >= MAX_MATCHES ? `${MAX_MATCHES}+` : search.count}`;
  return (
    <search className="diff-search" aria-label="Find in the changes">
      <Search size={16} aria-hidden="true" className="diff-search-icon" />
      <input
        ref={search.field}
        className="diff-search-field"
        type="text"
        aria-label="Find in the changes"
        placeholder="Find in the changes"
        title="⌘F or Ctrl+F again for the browser's find"
        spellCheck={false}
        value={search.query}
        onChange={(e) => search.search(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) search.previous();
            else search.next();
          } else if (e.key === "Escape") {
            e.preventDefault();
            search.close();
          }
        }}
      />
      <span className="diff-search-count" aria-live="polite">
        {said}
      </span>
      <button
        type="button"
        className="icon-btn"
        aria-label="Previous match"
        disabled={search.count === 0}
        onClick={search.previous}
      >
        <ChevronUp size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label="Next match"
        disabled={search.count === 0}
        onClick={search.next}
      >
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      <button type="button" className="icon-btn" aria-label="Close find" onClick={search.close}>
        <X size={16} aria-hidden="true" />
      </button>
    </search>
  );
}
