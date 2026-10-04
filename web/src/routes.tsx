import type { ReactNode } from "react";
import type { Me } from "./api.js";
import { Activity } from "./pages/Activity.js";
import { Agents } from "./pages/Agents.js";
import { Defaults } from "./pages/Defaults.js";
import { Device } from "./pages/Device.js";
import { Keys } from "./pages/Keys.js";
import { Memory } from "./pages/Memory.js";
import { Overview } from "./pages/Overview.js";
import { Plugins } from "./pages/Plugins.js";
import { ReviewDetail } from "./pages/ReviewDetail.js";
import { ReviewSettings } from "./pages/ReviewSettings.js";
import { Reviews } from "./pages/Reviews.js";
import { Rules } from "./pages/Rules.js";
import { Sessions } from "./pages/Sessions.js";
import { Settings } from "./pages/Settings.js";
import { NotFound } from "./ui.js";

// The signed-in pages by path. An unknown path is a 404, not the overview.

/** A path segment, or null when it is not valid percent-encoding. */
function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function pageFor(path: string, me: Me): ReactNode {
  if (path.startsWith("/reviews/")) {
    const id = decode(path.slice("/reviews/".length));
    return id ? <ReviewDetail id={id} /> : <NotFound />;
  }
  switch (path) {
    case "/":
      return <Overview login={me.login} />;
    case "/device":
      return <Device />;
    case "/activity":
      return <Activity />;
    case "/memory":
      return <Memory />;
    case "/reviews":
      return <Reviews />;
    case "/agents":
    case "/models":
      return <Agents />;
    case "/review-settings":
      return <ReviewSettings />;
    case "/rules":
      return <Rules />;
    case "/plugins":
      return <Plugins />;
    case "/defaults":
      return <Defaults />;
    case "/keys":
      return <Keys />;
    case "/sessions":
      return <Sessions />;
    case "/settings":
      return <Settings me={me} />;
    default:
      return <NotFound />;
  }
}
