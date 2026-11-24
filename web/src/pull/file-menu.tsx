import Ellipsis from "lucide-react/icons/ellipsis";
import MessageSquare from "lucide-react/icons/message-square";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLinkItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { useToast } from "../toast.js";

// What a changed file's head offers beside Viewed: how many comments are on
// it, leading to the first, and a menu of what else can be done with it.

/**
 * The file as it is at the head, on the platform, from the pull request's
 * own page there: GitHub's /pull/N and GitLab's /-/merge_requests/N become
 * the repository's blob at the head. null for any other address.
 */
export function fileAtHead(pullUrl: string | null, head: string, path: string): string | null {
  if (!pullUrl || !/^[0-9a-f]{7,64}$/i.test(head)) return null;
  let url: URL;
  try {
    url = new URL(pullUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const file = path.split("/").map(encodeURIComponent).join("/");
  const github = /^(.*)\/pull\/\d+\/?$/.exec(url.pathname);
  const gitlab = /^(.*)\/-\/merge_requests\/\d+\/?$/.exec(url.pathname);
  const repo = github?.[1] ?? gitlab?.[1];
  if (!repo) return null;
  return `${url.origin}${repo}${github ? "" : "/-"}/blob/${head}/${file}`;
}

export function FileComments(props: { path: string; count: number; onOpen: () => void }) {
  if (props.count === 0) return null;
  const words = `${props.count} comment${props.count === 1 ? "" : "s"}`;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="diff-comments"
      aria-label={`${words} on ${props.path}: go to the first`}
      title="Go to the first"
      onClick={props.onOpen}
    >
      <MessageSquare aria-hidden="true" />
      <span className="num">{props.count}</span>
    </Button>
  );
}

export function FileMenu(props: {
  path: string;
  /** The file at the head on the platform; null where none can be linked. */
  atHead: string | null;
  viewed: boolean;
  onViewed: (viewed: boolean) => void;
  folded: boolean;
  onFold: (folded: boolean) => void;
}) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.path);
      toast("Path copied", "success");
    } catch {
      toast("Could not copy the path", "error");
    }
  };
  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost" size="icon-sm" className="diff-menu" />}
        aria-label={`Actions for ${props.path}`}
      >
        <Ellipsis aria-hidden="true" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => void copy()}>Copy path</MenuItem>
        {props.atHead && (
          <MenuLinkItem href={props.atHead} target="_blank" rel="noopener noreferrer">
            View file at head
          </MenuLinkItem>
        )}
        <MenuItem onClick={() => props.onViewed(!props.viewed)}>
          {props.viewed ? "Mark not viewed" : "Mark viewed"}
        </MenuItem>
        <MenuItem onClick={() => props.onFold(!props.folded)}>
          {props.folded ? "Expand" : "Collapse"}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
