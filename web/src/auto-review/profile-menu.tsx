import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/ui/menu";
import {
  type AutoReviewRepoView,
  REVIEW_PROFILES,
  type ReviewProfile,
  type ReviewProfileView,
} from "../../../src/shared/index.js";
import { api } from "../api.js";
import { ActionError, useAction } from "../ui.js";

const PROFILE: Record<ReviewProfile, { name: string; says: string }> = {
  quiet: { name: "Quiet", says: "Correctness and security, on the changed lines only." },
  balanced: { name: "Balanced", says: "The standard review." },
  thorough: { name: "Thorough", says: "Every reviewer, two samples each. About twice the cost." },
};

/** How much a repository's hosted reviews say, chosen from a menu that explains each profile. */
export function ProfileMenu(props: { r: AutoReviewRepoView }) {
  const [profile, setProfile] = useState(props.r.profile);
  const save = useAction((next: ReviewProfile) =>
    api<ReviewProfileView>(`/auto-review/repos/${encodeURIComponent(props.r.id)}/profile`, {
      method: "PUT",
      body: JSON.stringify({ profile: next }),
    }),
  );
  const change = async (next: ReviewProfile) => {
    const saved = await save.run(next);
    if (saved) setProfile(saved.profile);
  };
  return (
    <div className="profile-menu">
      <Menu>
        <MenuTrigger
          render={<Button type="button" variant="outline" size="sm" loading={save.busy} />}
          aria-label={`Review profile of ${props.r.fullName}: ${PROFILE[profile].name}`}
        >
          {PROFILE[profile].name}
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuRadioGroup value={profile} onValueChange={(next) => change(next as ReviewProfile)}>
            {REVIEW_PROFILES.map((p) => (
              <MenuRadioItem key={p} value={p} className="profile-item">
                <span className="strong">{PROFILE[p].name}</span>
                <span className="subtle small">{PROFILE[p].says}</span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
      {save.error !== null && <ActionError what="change the profile" error={save.error} />}
    </div>
  );
}
