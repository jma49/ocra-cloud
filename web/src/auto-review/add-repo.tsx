import { type FormEvent, useState } from "react";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "@/components/ui/autocomplete";
import { Button } from "@/components/ui/button";
import type {
  AutoReviewEnrolledView,
  AutoReviewRepoView,
  CodePlatformKind,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { PlatformSelect } from "../platform-names.js";
import { useAction } from "../ui.js";

// Adding a repository to auto review: its path, typed or picked from the
// repositories the platform lists for the user (on GitHub, the ones the
// App is installed on).

export type Added = AutoReviewEnrolledView;

/** The repositories each platform lists for the user, as /platforms/repos answers. */
export type ListedRepos = {
  platforms: { platform: CodePlatformKind; repositories: { fullName: string }[] }[];
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Whether the platform's listing names the repository: on GitHub, that the App reaches it. */
export const listedOn = (listed: ListedRepos | undefined, repo: AutoReviewRepoView) =>
  (listed?.platforms ?? []).some(
    (p) =>
      p.platform === repo.platform && p.repositories.some((r) => same(r.fullName, repo.fullName)),
  );

/** The platform's listed repositories that are not under review yet. */
export const offeredRepos = (
  listed: ListedRepos | undefined,
  platform: CodePlatformKind,
  enrolled: readonly Pick<AutoReviewRepoView, "platform" | "fullName">[],
) =>
  (listed?.platforms ?? [])
    .filter((p) => p.platform === platform)
    .flatMap((p) => p.repositories.map((r) => r.fullName))
    .filter((name) => !enrolled.some((r) => r.platform === platform && same(r.fullName, name)));

export function AddRepo(props: {
  full: boolean;
  platforms: readonly CodePlatformKind[];
  listed: ListedRepos | undefined;
  enrolled: readonly AutoReviewRepoView[];
  onAdded: (a: Added) => void;
}) {
  const [platform, setPlatform] = useState<CodePlatformKind>(props.platforms[0] ?? "github");
  const [fullName, setFullName] = useState("");
  const add = useAction(() =>
    api<Added>("/auto-review/repos", {
      method: "POST",
      body: JSON.stringify({ platform, fullName: fullName.trim() }),
    }),
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const a = await add.run();
    if (!a) return;
    setFullName("");
    props.onAdded(a);
  };
  const offered = offeredRepos(props.listed, platform, props.enrolled);
  return (
    <form className="card card-pad stack add-form" onSubmit={submit}>
      <h2 className="card-title">Add a repository</h2>
      <div className="add-fields">
        <PlatformSelect platforms={props.platforms} value={platform} onChange={setPlatform} />
        <div className="grow add-repo-field">
          <Autocomplete
            items={offered}
            value={fullName}
            onValueChange={setFullName}
            openOnInputClick
          >
            <AutocompleteInput
              size="sm"
              className="mono"
              aria-label="Repository"
              placeholder={platform === "gitlab" ? "group/project" : "owner/repo"}
              maxLength={400}
            />
            {offered.length > 0 && (
              <AutocompletePopup>
                <AutocompleteEmpty>
                  None of your repositories matches. Its path still works.
                </AutocompleteEmpty>
                <AutocompleteList>
                  {(name: string) => (
                    <AutocompleteItem key={name} value={name} className="mono">
                      {name}
                    </AutocompleteItem>
                  )}
                </AutocompleteList>
              </AutocompletePopup>
            )}
          </Autocomplete>
        </div>
        <Button type="submit" size="sm" disabled={add.busy || props.full || !fullName.trim()}>
          Add
        </Button>
      </div>
      {props.full && (
        <span className="subtle small">An account reviews at most 100 repositories.</span>
      )}
      {add.error !== null && (
        <p className="error" role="alert">
          Could not add it: {why(add.error)}.
        </p>
      )}
    </form>
  );
}
