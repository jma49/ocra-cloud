import ChevronDown from "lucide-react/icons/chevron-down";
import ListFilter from "lucide-react/icons/list-filter";
import { type FormEvent, type Ref, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "../toast.js";
import { EmptyNote } from "../ui.js";
import {
  choicesSet,
  type FileKind,
  type FileViews,
  isNarrowed,
  KINDS,
  MAX_NAME,
  MAX_VIEWS,
  type ViewedChoice,
} from "./file-views.js";

// Over the file tree: the view shown, a menu of what narrows the files, and
// a field for their paths. A view is the narrowing kept under a name.

const KIND_LABEL: Record<FileKind, string> = {
  added: "Added",
  modified: "Modified",
  removed: "Removed",
  renamed: "Renamed",
};

const VIEWED: { value: ViewedChoice; label: string }[] = [
  { value: "any", label: "Viewed or not" },
  { value: "unviewed", label: "Not viewed" },
  { value: "viewed", label: "Viewed" },
];

/** A saved name is never empty, so the empty value is all files. */
const ALL = "";

const nameOf = (v: FileViews) => v.picked?.name ?? (v.edited ? "Custom" : "All files");

function ViewMenu(props: {
  views: FileViews;
  onName: () => void;
  trigger: Ref<HTMLButtonElement>;
}) {
  const { views } = props;
  const toast = useToast();
  // Naming a view moves focus to its field, so the menu leaves focus where it is.
  const naming = useRef(false);
  const name = nameOf(views);
  const edited = views.picked !== null && views.edited;
  const picked = views.picked;
  const remove = () => {
    if (!picked) return;
    toast(`Deleted the view “${picked.name}”`, undefined, {
      label: "Undo",
      run: views.remove(picked),
    });
  };
  return (
    <Menu>
      <MenuTrigger
        ref={props.trigger}
        render={<Button type="button" variant="outline" size="sm" className="file-view-pick" />}
        aria-label={`File view: ${name}${edited ? ", edited" : ""}`}
      >
        <span className="file-view-name">{name}</span>
        {edited && <span className="subtle">edited</span>}
        <ChevronDown size={14} aria-hidden="true" />
      </MenuTrigger>
      <MenuPopup
        align="start"
        finalFocus={() => {
          const back = !naming.current;
          naming.current = false;
          return back;
        }}
      >
        <MenuRadioGroup value={picked?.name ?? ALL}>
          <MenuRadioItem value={ALL} closeOnClick onClick={() => views.pick(null)}>
            All files
          </MenuRadioItem>
          {views.views.map((v) => (
            <MenuRadioItem key={v.name} value={v.name} closeOnClick onClick={() => views.pick(v)}>
              {v.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        {(views.edited || picked) && <MenuSeparator />}
        {picked && edited && (
          <MenuItem onClick={() => views.save(picked.name)}>Update “{picked.name}”</MenuItem>
        )}
        {views.edited && (
          <MenuItem
            disabled={views.views.length >= MAX_VIEWS}
            onClick={() => {
              naming.current = true;
              props.onName();
            }}
          >
            Save as new view…
          </MenuItem>
        )}
        {picked && <MenuItem onClick={remove}>Delete “{picked.name}”</MenuItem>}
      </MenuPopup>
    </Menu>
  );
}

function FilterMenu(props: { views: FileViews }) {
  const { views } = props;
  const n = views.narrowing;
  const set = choicesSet(n);
  const label = set > 0 ? `Filter files: ${set} set` : "Filter files";
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button type="button" variant="outline" size="sm" className="file-filter-menu" />
              }
              aria-label={label}
            />
          }
        >
          <ListFilter size={14} aria-hidden="true" />
          {set > 0 && <span className="num">{set}</span>}
        </TooltipTrigger>
        <TooltipPopup>Filter files</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>Change</MenuGroupLabel>
          {KINDS.map((k) => (
            <MenuCheckboxItem
              key={k}
              checked={n.kinds.includes(k)}
              closeOnClick={false}
              onCheckedChange={(on) =>
                views.change({ kinds: on ? [...n.kinds, k] : n.kinds.filter((x) => x !== k) })
              }
            >
              {KIND_LABEL[k]}
            </MenuCheckboxItem>
          ))}
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Viewed</MenuGroupLabel>
          <MenuRadioGroup
            value={n.viewed}
            onValueChange={(v) => views.change({ viewed: v as ViewedChoice })}
          >
            {VIEWED.map((v) => (
              <MenuRadioItem key={v.value} value={v.value} closeOnClick={false}>
                {v.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuCheckboxItem
          checked={n.hideGenerated}
          closeOnClick={false}
          onCheckedChange={(on) => views.change({ hideGenerated: on })}
        >
          Hide lock and generated files
        </MenuCheckboxItem>
        {isNarrowed(n) && (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => views.pick(null)}>Show all files</MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}

function NameView(props: { onSave: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    props.onSave(name);
    props.onClose();
  };
  return (
    <form className="file-view-save" onSubmit={submit}>
      <input
        className="input"
        // biome-ignore lint/a11y/noAutofocus: the field opens on the user's own pick of Save as new view.
        autoFocus
        aria-label="Name of the view"
        placeholder="Name this view"
        maxLength={MAX_NAME}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          props.onClose();
        }}
      />
      <Button type="submit" variant="outline" size="sm" disabled={!name.trim()}>
        Save
      </Button>
    </form>
  );
}

/** The view picker, the filter menu and the path field. */
export function FileViewBar(props: { views: FileViews }) {
  const { views } = props;
  const [naming, setNaming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <div className="file-views">
      <div className="file-views-row">
        <ViewMenu views={views} onName={() => setNaming(true)} trigger={trigger} />
        <FilterMenu views={views} />
      </div>
      {naming && (
        <NameView
          onSave={views.save}
          onClose={() => {
            setNaming(false);
            trigger.current?.focus();
          }}
        />
      )}
      <input
        className="input file-filter"
        type="search"
        aria-label="Filter files by path"
        placeholder="Filter by path or glob"
        title="Words or globs (*.ts, src/**); a word after ! leaves files out"
        value={views.narrowing.path}
        onChange={(e) => views.change({ path: e.target.value })}
      />
    </div>
  );
}

/** In place of the diffs when the view leaves none: what happened, and the way back. */
export function NoFileShown(props: { onShowAll: () => void }) {
  return (
    <div className="file-views-none">
      <EmptyNote>No changed file fits this view.</EmptyNote>
      <Button type="button" variant="outline" size="sm" onClick={props.onShowAll}>
        Show all files
      </Button>
    </div>
  );
}
