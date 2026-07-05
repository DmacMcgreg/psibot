import { test, expect } from "bun:test";
import { groupDuplicateItems } from "./library.ts";

test("groups consecutive items sharing a normalized URL", () => {
  const items = [
    { id: 1, title: "Introducing AgentFlow", url: "https://example.com/agentflow" },
    { id: 2, title: "Introducing AgentFlow (research)", url: "https://example.com/agentflow/" },
    { id: 3, title: "Other story", url: "https://example.com/other" },
  ];
  const groups = groupDuplicateItems(items);
  expect(groups.length).toBe(2);
  expect(groups[0].primary.id).toBe(1);
  expect(groups[0].others.map((o) => o.id)).toEqual([2]);
  expect(groups[1].primary.id).toBe(3);
});

test("falls back to normalized title when url is missing", () => {
  const items = [
    { id: 1, title: "Same Title!!", url: null },
    { id: 2, title: "same title", url: null },
  ];
  const groups = groupDuplicateItems(items);
  expect(groups.length).toBe(1);
  expect(groups[0].others.map((o) => o.id)).toEqual([2]);
});

test("does not group non-consecutive duplicates", () => {
  const items = [
    { id: 1, title: "A", url: "https://a.com" },
    { id: 2, title: "B", url: "https://b.com" },
    { id: 3, title: "A again", url: "https://a.com" },
  ];
  const groups = groupDuplicateItems(items);
  expect(groups.length).toBe(3);
});
