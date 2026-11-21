import { useEffect } from "react";

let page: string | undefined;
let count = 0;

function apply() {
  const name = page ? `${page} · ocra Cloud` : "ocra Cloud";
  document.title = count > 0 ? `(${count}) ${name}` : name;
}

export function setPageTitle(label: string | undefined) {
  page = label;
  apply();
}

/** A count of what waits on the user, shown in the tab while the page is open. */
export function useTitleCount(n: number) {
  useEffect(() => {
    count = n;
    apply();
    return () => {
      count = 0;
      apply();
    };
  }, [n]);
}
