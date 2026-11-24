import { Status } from "@/components/status";

/** A review's verdict as its standing: mark and word, "Incomplete" where some files went unreviewed. */
export function VerdictStatus(props: {
  verdict: string | null;
  complete: boolean;
  /** In a table column: "Comments" for approved with comments. */
  brief?: boolean;
}) {
  const { verdict, complete } = props;
  if (!complete)
    return (
      <Status tone="warn" title="Some files were not reviewed">
        Incomplete
      </Status>
    );
  if (verdict === "significant_concerns") return <Status tone="err">Significant concerns</Status>;
  if (verdict === "minor_issues") return <Status tone="warn">Minor issues</Status>;
  if (verdict === "approved_with_comments")
    return <Status tone="ok">{props.brief ? "Comments" : "Approved with comments"}</Status>;
  if (verdict === "approved") return <Status tone="ok">Approved</Status>;
  return <Status tone="quiet">–</Status>;
}
