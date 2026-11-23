import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ProviderLogo } from "./provider-logo.js";

afterEach(cleanup);

const tile = (name: string, label: string) =>
  render(<ProviderLogo name={name} label={label} />).container.firstElementChild as HTMLElement;

it("draws a listed provider's own mark, and the same one for its China endpoint", () => {
  const openai = tile("openai", "OpenAI");
  expect(openai.querySelector("svg path")?.getAttribute("d")).toBeTruthy();
  expect(openai.textContent).toBe("");
  const d = (name: string) => tile(name, "Qwen").querySelector("path")?.getAttribute("d");
  expect(d("qwen-cn")).toBe(d("qwen"));
  expect(d("qwen")).not.toBe(openai.querySelector("path")?.getAttribute("d"));
});

it("keeps the parts a mark draws at half strength", () => {
  const paths = [...tile("volcengine", "Volcengine").querySelectorAll("path")];
  expect(paths.map((p) => p.getAttribute("fill-opacity"))).toEqual([
    "0.5",
    null,
    "0.5",
    null,
    null,
  ]);
});

it("falls back to two letters for a name the gateway does not list", () => {
  const unknown = tile("acme-llm", "Acme LLM");
  expect(unknown.querySelector("svg")).toBeNull();
  expect(unknown.textContent).toBe("Ac");
});
