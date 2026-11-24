import ThumbsDown from "lucide-react/icons/thumbs-down";
import ThumbsUp from "lucide-react/icons/thumbs-up";

// How people reacted to ocra's comment of a finding on the platform: the
// thumbs up and down it got, as ocra last read them. Nothing when it got none.

export function FindingReactions(props: { up: number; down: number }) {
  const { up, down } = props;
  if (up === 0 && down === 0) return null;
  const said = [up > 0 && `${up} thumbs up`, down > 0 && `${down} thumbs down`]
    .filter(Boolean)
    .join(", ");
  return (
    <span className="finding-reactions subtle small" role="img" aria-label={`Reactions: ${said}`}>
      {up > 0 && (
        <span>
          <ThumbsUp size={12} aria-hidden="true" />
          {up}
        </span>
      )}
      {down > 0 && (
        <span>
          <ThumbsDown size={12} aria-hidden="true" />
          {down}
        </span>
      )}
    </span>
  );
}
