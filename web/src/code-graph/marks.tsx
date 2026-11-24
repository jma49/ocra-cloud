import type { LucideIcon } from "lucide-react";
import Box from "lucide-react/icons/box";
import Braces from "lucide-react/icons/braces";
import List from "lucide-react/icons/list";
import Package from "lucide-react/icons/package";
import SquareFunction from "lucide-react/icons/square-function";
import Type from "lucide-react/icons/type";
import Variable from "lucide-react/icons/variable";
import { FileTypeIcon } from "../pull/file-icon.js";

// How the explorer marks what it draws: a file or folder by its kind, as the
// file tree does, a symbol by what the parser calls it. Every name and path
// comes from the reviewed repository and is drawn as text.

const KIND_ICONS: Record<string, LucideIcon> = {
  function: SquareFunction,
  method: SquareFunction,
  class: Box,
  interface: Type,
  type: Type,
  enum: List,
  module: Package,
  variable: Variable,
};

export function SymbolMark(props: { kind: string }) {
  const Icon = KIND_ICONS[props.kind] ?? Braces;
  return <Icon size={16} aria-hidden="true" className="symbol-mark" />;
}

export function FileMark(props: { path: string; folder?: boolean }) {
  return <FileTypeIcon name={baseOf(props.path)} folder={props.folder === true} />;
}

export const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/**
 * A path with its folders quiet and its last part in ink, so the eye lands
 * on the name; short of room, the folders give way first. The whole path is
 * its title.
 */
export function PathText(props: { path: string }) {
  const dir = dirOf(props.path);
  return (
    <span className="path-text mono" title={props.path}>
      {dir && <span className="path-dir">{dir}/</span>}
      <span className="path-base">{baseOf(props.path)}</span>
    </span>
  );
}

export const uses = (n: number) => `${n.toLocaleString()} use${n === 1 ? "" : "s"}`;
