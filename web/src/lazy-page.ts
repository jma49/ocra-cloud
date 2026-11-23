import { type ComponentType, type LazyExoticComponent, lazy } from "react";

// biome-ignore lint/suspicious/noExplicitAny: any page's props
type Page = ComponentType<any>;

export type LazyPage<C extends Page> = LazyExoticComponent<C> & {
  /** Loads the page's code ahead of its first render; asking again costs nothing. */
  preload: () => Promise<unknown>;
};

/** A page component loaded on demand from the module's export `name`. */
export function lazyPage<M extends Record<K, Page>, K extends keyof M>(
  load: () => Promise<M>,
  name: K,
): LazyPage<M[K]> {
  let loaded: Promise<M> | undefined;
  const preload = () => {
    loaded ??= load().catch((e: unknown) => {
      // A failed fetch (a deploy replaced the chunk, a dropped network) is asked again next time.
      loaded = undefined;
      throw e;
    });
    return loaded;
  };
  return Object.assign(
    lazy(() => preload().then((m) => ({ default: m[name] }))),
    { preload },
  );
}

/** Whether a rendered page element's type is a lazy page, so its code can load ahead. */
export function isLazyPage(type: unknown): type is LazyPage<Page> {
  return typeof type === "object" && type !== null && "preload" in type;
}
