import { test, expect } from "vitest";
import { Counter } from "../src/Counter.ck";
import { TodoApp } from "../src/TodoApp.ck";
import { Greeting } from "../src/Greeting.ck";
import { mount } from "@cookedjs/cooked";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// End-to-end: .ck source -> vite-plugin-cooked (native compile) -> runtime -> DOM.
test("counter renders props/state/derived and reacts to clicks", () => {
  const root = document.createElement("div");
  mount(Counter, root, { label: "N" });

  const h1 = root.querySelector("h1")!;
  const btn = root.querySelector("button")!;

  expect(root.querySelector(".counter")).not.toBeNull();
  expect(h1.textContent).toBe("N: 0 (x2 = 0)");
  expect(btn.textContent).toBe("+");

  btn.dispatchEvent(new Event("click"));
  expect(h1.textContent).toBe("N: 1 (x2 = 2)");

  btn.dispatchEvent(new Event("click"));
  expect(h1.textContent).toBe("N: 2 (x2 = 4)");
});

test("default prop applies when none passed", () => {
  const root = document.createElement("div");
  mount(Counter, root);
  expect(root.querySelector("h1")!.textContent).toBe("Count: 0 (x2 = 0)");
});

test("todo app: input binding, conditionals, lists and child components", () => {
  const root = document.createElement("div");
  mount(TodoApp, root);

  const input = root.querySelector("input")!;
  const addBtn = root.querySelector("button[type=submit]")!;
  const form = root.querySelector("form")!;

  // empty state + disabled submit
  expect(root.querySelector(".empty")).not.toBeNull();
  expect(addBtn.hasAttribute("disabled")).toBe(true);
  expect(root.querySelector("h1")!.textContent).toBe("Todos (0)");

  // type into the input (value property binding)
  input.value = "buy milk";
  input.dispatchEvent(new Event("input"));
  expect(addBtn.hasAttribute("disabled")).toBe(false);

  // submit adds a todo via the child component
  form.dispatchEvent(new Event("submit"));
  expect(root.querySelector(".empty")).toBeNull();
  expect(root.querySelectorAll("li.todo").length).toBe(1);
  expect(root.querySelector("li.todo span")!.textContent).toBe("buy milk");
  expect(root.querySelector("h1")!.textContent).toBe("Todos (1)");
  // input cleared after add
  expect(input.value).toBe("");

  // add a second, then remove the first
  input.value = "walk dog";
  input.dispatchEvent(new Event("input"));
  form.dispatchEvent(new Event("submit"));
  expect(root.querySelectorAll("li.todo").length).toBe(2);

  root.querySelector("li.todo button.remove")!.dispatchEvent(new Event("click"));
  const texts = [...root.querySelectorAll("li.todo span")].map((s) => s.textContent);
  expect(texts).toEqual(["walk dog"]);
  expect(root.querySelector("h1")!.textContent).toBe("Todos (1)");
});

test("async component renders after awaiting", async () => {
  const root = document.createElement("div");
  mount(Greeting, root, { name: "cook" });
  expect(root.querySelector(".greeting")).toBeNull();
  await tick();
  expect(root.querySelector(".greeting")!.textContent).toBe("Hello, cook!");
});

test("mount disposer removes nodes and stops updates", () => {
  const root = document.createElement("div");
  const dispose = mount(Counter, root);
  const btn = root.querySelector("button")!;
  dispose();
  expect(root.querySelector(".counter")).toBeNull();
  // clicking the detached button must not throw
  btn.dispatchEvent(new Event("click"));
});
