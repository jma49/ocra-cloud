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
  const art = (name: string) => tile(name, "Qwen").querySelector("img")?.getAttribute("src");
  expect(art("qwen-cn")).toBe(art("qwen"));
});

it("draws a brand with colours of its own from its colour art, and a black mark in ink", () => {
  const deepseek = tile("deepseek", "DeepSeek");
  expect(deepseek.querySelector("img")?.getAttribute("src")).toBe("/marks/deepseek.svg");
  expect(deepseek.querySelector("img")?.getAttribute("alt")).toBe("");
  expect(tile("openai", "OpenAI").querySelector("svg")?.getAttribute("fill")).toBe("currentColor");
});

it("falls back to two letters for a name the gateway does not list", () => {
  const unknown = tile("acme-llm", "Acme LLM");
  expect(unknown.querySelector("svg")).toBeNull();
  expect(unknown.textContent).toBe("Ac");
});
