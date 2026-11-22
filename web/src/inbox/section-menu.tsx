import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";

/** What can be done with one section of the inbox; a move is left out at either end. */
export function SectionMenu(props: {
  title: string;
  edit: () => void;
  up: (() => void) | undefined;
  down: (() => void) | undefined;
  hide: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger className="icon-btn" aria-label={`Section ${props.title}`}>
        ⋯
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={props.edit}>Edit</MenuItem>
        <MenuItem disabled={!props.up} onClick={props.up}>
          Move up
        </MenuItem>
        <MenuItem disabled={!props.down} onClick={props.down}>
          Move down
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={props.hide}>Hide</MenuItem>
      </MenuPopup>
    </Menu>
  );
}
