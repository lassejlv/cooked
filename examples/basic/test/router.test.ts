import { test, expect } from "vitest";
import { mount } from "cooked";
import { createRouter, navigate } from "cooked/router";
import { routes } from "virtual:cooked-routes";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// Route modules go through Vite's transform on first import — poll instead of
// assuming a single macrotask.
async function settled(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await tick();
  }
}

// End-to-end: file-based routes (.ck) -> virtual:cooked-routes -> router -> DOM.
test("file-based routes render inside the layout and navigate", async () => {
  history.pushState(null, "", "/");
  const root = document.createElement("div");
  const router = createRouter({ routes });
  const dispose = mount(router.view, root);
  await settled(() => root.querySelector(".home") !== null);

  // Layout nav + home page rendered.
  expect(root.querySelector("nav.nav")).not.toBeNull();
  expect(root.querySelector(".home")).not.toBeNull();
  expect(root.textContent).toContain("Welcome to the Cooked router example.");

  // Dynamic segment.
  navigate("/posts/$id", { params: { id: "42" } });
  await settled(() => root.querySelector(".post") !== null);
  expect(root.querySelector(".post h1")?.textContent).toBe("Post 42");
  expect(root.querySelector("nav.nav")).not.toBeNull();

  // Counter page keeps full interactivity.
  navigate("/counter");
  await settled(() => root.querySelector(".counter") !== null);
  const btn = root.querySelector<HTMLButtonElement>(".counter button")!;
  btn.dispatchEvent(new Event("click"));
  expect(root.querySelector(".counter h1")?.textContent).toContain("Count: 1");

  // Link click navigates without reload.
  const home = [...root.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/")!;
  home.dispatchEvent(new MouseEvent("click", { button: 0, cancelable: true }));
  await settled(() => root.querySelector(".home") !== null);
  expect(root.querySelector(".home")).not.toBeNull();
  expect(location.pathname).toBe("/");

  dispose();
  router.dispose();
});
