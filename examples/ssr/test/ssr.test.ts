import { test, expect } from "vitest";
import { renderToString } from "@cookedjs/cooked/server";
import { routes } from "virtual:cooked-routes";

// End-to-end: .ck routes -> server render in happy-dom -> HTML string.
test("renders the home route with layout", async () => {
  const { html, matched } = await renderToString(routes, "/");
  expect(matched).toBe(true);
  expect(html).toContain("<nav class=\"nav\">");
  expect(html).toContain("Server-rendered Cooked");
  expect(html).toContain("Clicked 0");
});

test("renders dynamic params", async () => {
  const { html, matched } = await renderToString(routes, "/posts/7");
  expect(matched).toBe(true);
  expect(html).toContain("Post 7");
});

test("reports unmatched routes", async () => {
  const { matched } = await renderToString(routes, "/nope");
  expect(matched).toBe(false);
});

test("renders are isolated between requests", async () => {
  const [a, b] = await Promise.all([
    renderToString(routes, "/posts/1"),
    renderToString(routes, "/posts/2"),
  ]);
  expect(a.html).toContain("Post 1");
  expect(b.html).toContain("Post 2");
});
