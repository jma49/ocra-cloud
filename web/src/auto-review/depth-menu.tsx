import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/ui/menu";
import {
  type AutoReviewRepoView,
  REVIEW_DEPTHS,
  type ReviewDepth,
  type ReviewDepthView,
} from "../../../src/shared/index.js";
import { api } from "../api.js";
import { ActionError, useAction } from "../ui.js";
import { DEPTH } from "./depths.js";

/** How thorough a repository's hosted reviews are, chosen from a menu that explains each depth. */
export function DepthMenu(props: { r: AutoReviewRepoView }) {
  const [depth, setDepth] = useState(props.r.depth);
  const save = useAction((next: ReviewDepth) =>
    api<ReviewDepthView>(`/auto-review/repos/${encodeURIComponent(props.r.id)}/depth`, {
      method: "PUT",
      body: JSON.stringify({ depth: next }),
    }),
  );
  const change = async (next: ReviewDepth) => {
    const saved = await save.run(next);
    if (saved) setDepth(saved.depth);
  };
  return (
    <div className="profile-menu">
      <Menu>
        <MenuTrigger
          render={<Button type="button" variant="outline" size="sm" loading={save.busy} />}
          aria-label={`Review depth of ${props.r.fullName}: ${DEPTH[depth].name}`}
        >
          {DEPTH[depth].name}
        </MenuTrigger>
        <MenuPopup align="start">
          <DepthChoices value={depth} onChange={change} />
        </MenuPopup>
      </Menu>
      {save.error !== null && <ActionError what="change the depth" error={save.error} />}
    </div>
  );
}

/**
 * The depths as radio items of a menu, each with what it does. A pick closes
 * the menu (radio items stay open by default), so the next click acts.
 */
export function DepthChoices(props: { value: ReviewDepth; onChange: (next: ReviewDepth) => void }) {
  return (
    <MenuRadioGroup
      value={props.value}
      onValueChange={(next) => props.onChange(next as ReviewDepth)}
    >
      {REVIEW_DEPTHS.map((d) => (
        <MenuRadioItem key={d} value={d} className="profile-item" closeOnClick>
          <span className="strong">{DEPTH[d].name}</span>
          <span className="subtle small">{DEPTH[d].says}</span>
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}
