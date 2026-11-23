import MapPinOff from "lucide-react/icons/map-pin-off";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import type { CodePlatformKind } from "../../../src/shared/index.js";
import { ApiError } from "../api.js";
import { PlatformMark } from "../platform-mark.js";
import { Link } from "../router.js";
import { LoadError, Loading } from "../ui.js";

/** Where the pull request lives, on the quiet line its page opens with. */
function Where(props: { platform: CodePlatformKind; where: string }) {
  return (
    <p className="pull-where">
      <PlatformMark platform={props.platform} size={14} />
      {props.where}
    </p>
  );
}

/**
 * The page while its files are read, in the frame it lands in: the head,
 * then the overview beside the rail, so nothing moves when it arrives.
 */
export function PullLoading(props: { platform: CodePlatformKind; where: string }) {
  return (
    <>
      <Where {...props} />
      <div className="pull-head">
        <h1 className="sr-only">{props.where}</h1>
        <div className="skeleton pull-head-skeleton" aria-hidden="true">
          <span className="skeleton-bar" />
          <span className="skeleton-bar" />
        </div>
      </div>
      <div className="pull-overview">
        <div className="pull-about">
          <Loading what="the pull request" rows={4} />
        </div>
        <aside className="pull-rail" aria-hidden="true">
          <Loading what="its status" inCard rows={4} />
        </aside>
      </div>
    </>
  );
}

/** A pull request that could not be read: gone or out of sight says so, anything else can be tried again. */
export function PullFailed(props: {
  platform: CodePlatformKind;
  where: string;
  error: unknown;
  retry: () => void;
}) {
  const gone = props.error instanceof ApiError && props.error.status === 404;
  return (
    <>
      <h1 className="pull-failed-title">
        <PlatformMark platform={props.platform} size={20} />
        {props.where}
      </h1>
      {gone ? (
        <div className="card">
          <EmptyState
            icon={MapPinOff}
            title="This pull request is not here"
            action={
              <Button variant="outline" render={<Link to="/" />}>
                Back to inbox
              </Button>
            }
          >
            Its repository may have moved or been renamed, or your sign-in cannot see it.
          </EmptyState>
        </div>
      ) : (
        <LoadError what="the pull request" error={props.error} retry={props.retry} />
      )}
    </>
  );
}
