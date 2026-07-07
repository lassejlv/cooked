import { test, expect } from "vitest";
import { mount } from "@cookedjs/cooked";
import { App } from "../src/main.ck";

test("counter increments and decrements", () => {
  const root = document.createElement("div");
  mount(App, root);

  const [inc, dec] = [...root.querySelectorAll("button")];
  const count = root.querySelector("p")!;
  expect(count.textContent).toBe("0");

  inc.dispatchEvent(new Event("click"));
  inc.dispatchEvent(new Event("click"));
  expect(count.textContent).toBe("2");

  dec.dispatchEvent(new Event("click"));
  expect(count.textContent).toBe("1");
});
