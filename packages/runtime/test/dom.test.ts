import { describe, it, expect, vi } from "vitest";
import { signal, effect } from "../src/reactive.js";
import {
  insert,
  keyed,
  append,
  setAttr,
  setProp,
  setStyle,
  listen,
  mount,
  hot,
  replaceHot,
  withDefaults,
} from "../src/dom.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("insert", () => {
  it("renders and reactively updates text", () => {
    const parent = document.createElement("div");
    const count = signal(0);
    insert(parent, () => `count is ${count.get()}`);
    expect(parent.textContent).toBe("count is 0");
    count.set(3);
    expect(parent.textContent).toBe("count is 3");
  });

  it("inserts nodes and replaces them", () => {
    const parent = document.createElement("div");
    const show = signal(true);
    insert(parent, () => {
      if (!show.get()) return null;
      const span = document.createElement("span");
      span.textContent = "hi";
      return span;
    });
    expect(parent.querySelector("span")?.textContent).toBe("hi");
    show.set(false);
    expect(parent.querySelector("span")).toBeNull();
  });
});

describe("insert (lists, fragments, markers)", () => {
  it("renders arrays and re-renders on change", () => {
    const parent = document.createElement("ul");
    const items = signal(["a", "b"]);
    insert(parent, () =>
      items.get().map((t) => {
        const li = document.createElement("li");
        li.textContent = t;
        return li;
      }),
    );
    expect(parent.textContent).toBe("ab");
    items.set(["x", "y", "z"]);
    expect(parent.textContent).toBe("xyz");
    expect(parent.querySelectorAll("li").length).toBe(3);
  });

  it("keeps dynamic content anchored before its marker", () => {
    const parent = document.createElement("div");
    const marker = document.createComment("");
    parent.appendChild(marker);
    const tail = document.createElement("footer");
    tail.textContent = "end";
    parent.appendChild(tail);

    const show = signal(false);
    insert(parent, () => (show.get() ? "hello " : null), marker);
    expect(parent.textContent).toBe("end");
    show.set(true);
    expect(parent.textContent).toBe("hello end");
    show.set(false);
    expect(parent.textContent).toBe("end");
  });

  it("expands DocumentFragments so they can be removed again", () => {
    const parent = document.createElement("div");
    const show = signal(true);
    insert(parent, () => {
      if (!show.get()) return null;
      const frag = document.createDocumentFragment();
      const a = document.createElement("i");
      a.textContent = "1";
      const b = document.createElement("i");
      b.textContent = "2";
      frag.append(a, b);
      return frag;
    });
    expect(parent.textContent).toBe("12");
    show.set(false);
    expect(parent.textContent).toBe("");
    show.set(true);
    expect(parent.textContent).toBe("12");
  });

  it("disposes effects belonging to replaced content", () => {
    const parent = document.createElement("div");
    const which = signal("a");
    const dep = signal(0);
    const spy = vi.fn(() => dep.get());
    insert(parent, () => {
      which.get();
      const span = document.createElement("span");
      // a nested reactive spot, as compiled element trees create
      effect(() => {
        spy();
        span.textContent = String(dep.get());
      });
      return span;
    });
    expect(spy).toHaveBeenCalledTimes(1);
    which.set("b"); // old span replaced; its effect must be disposed
    expect(spy).toHaveBeenCalledTimes(2);
    dep.set(1); // only the live span's effect re-runs
    expect(spy).toHaveBeenCalledTimes(3);
  });
});

describe("keyed", () => {
  it("moves existing nodes when keys reorder", () => {
    const parent = document.createElement("ul");
    const items = signal([
      { id: "a", text: "A" },
      { id: "b", text: "B" },
    ]);

    keyed(
      parent,
      () => items.get(),
      (item) => item.id,
      (item) => {
        const li = document.createElement("li");
        li.textContent = item.text;
        return li;
      },
    );

    const firstA = parent.querySelectorAll("li")[0];
    const firstB = parent.querySelectorAll("li")[1];
    items.set([
      { id: "b", text: "B" },
      { id: "a", text: "A" },
    ]);

    const next = parent.querySelectorAll("li");
    expect([...next].map((node) => node.textContent)).toEqual(["B", "A"]);
    expect(next[0]).toBe(firstB);
    expect(next[1]).toBe(firstA);
  });

  it("disposes effects for removed keys", () => {
    const parent = document.createElement("ul");
    const items = signal([{ id: "a" }, { id: "b" }]);
    const dep = signal(0);
    const spy = vi.fn();

    keyed(
      parent,
      () => items.get(),
      (item) => item.id,
      (item) => {
        const li = document.createElement("li");
        effect(() => {
          spy(item.id, dep.get());
          li.textContent = `${item.id}:${dep.get()}`;
        });
        return li;
      },
    );

    expect(spy).toHaveBeenCalledTimes(2);
    items.set([{ id: "b" }]);
    dep.set(1);
    expect(parent.textContent).toBe("b:1");
    expect(spy.mock.calls.map(([id]) => id)).toEqual(["a", "b", "b"]);
  });
});

describe("append (async components)", () => {
  it("appends sync nodes immediately", () => {
    const parent = document.createElement("div");
    const span = document.createElement("span");
    span.textContent = "now";
    append(parent, span);
    expect(parent.textContent).toBe("now");
  });

  it("renders a Promise<Node> in place when it resolves", async () => {
    const parent = document.createElement("div");
    const head = document.createElement("b");
    head.textContent = "a";
    const tail = document.createElement("b");
    tail.textContent = "c";

    parent.appendChild(head);
    const lazy = Promise.resolve().then(() => {
      const el = document.createElement("b");
      el.textContent = "b";
      return el;
    });
    append(parent, lazy);
    parent.appendChild(tail);

    expect(parent.textContent).toBe("ac");
    await tick();
    // resolved node lands between its siblings, where it was declared
    expect(parent.textContent).toBe("abc");
  });

  it("mounts async components when they resolve", async () => {
    const AsyncComp = async () => {
      await Promise.resolve();
      const p = document.createElement("p");
      p.textContent = "loaded";
      return p;
    };
    const root = document.createElement("div");
    mount(AsyncComp, root);
    expect(root.textContent).toBe("");
    await tick();
    expect(root.textContent).toBe("loaded");
  });

  it("does not render an async component disposed before it resolved", async () => {
    const AsyncComp = async () => {
      await Promise.resolve();
      return document.createElement("p");
    };
    const root = document.createElement("div");
    const dispose = mount(AsyncComp, root);
    dispose();
    await tick();
    expect(root.innerHTML).toBe("");
  });
});

describe("setProp + setStyle", () => {
  it("reactively sets DOM properties (input value)", () => {
    const input = document.createElement("input");
    const text = signal("hi");
    setProp(input, "value", () => text.get());
    expect(input.value).toBe("hi");
    text.set("hello");
    expect(input.value).toBe("hello");
  });

  it("applies style objects and removes dropped keys", () => {
    const el = document.createElement("div");
    const styles = signal<Record<string, string>>({ color: "red", fontSize: "12px" });
    setStyle(el, () => styles.get());
    expect(el.style.color).toBe("red");
    expect(el.style.fontSize).toBe("12px");
    styles.set({ color: "blue" });
    expect(el.style.color).toBe("blue");
    expect(el.style.fontSize).toBe("");
  });

  it("accepts cssText strings", () => {
    const el = document.createElement("div");
    setStyle(el, () => "color: green");
    expect(el.style.color).toBe("green");
  });
});

describe("withDefaults", () => {
  it("fills missing keys and keeps provided values", () => {
    const out = withDefaults<{ a: number; b: number }>({ a: 1 }, { a: 9, b: 2 });
    expect(out.a).toBe(1);
    expect(out.b).toBe(2);
  });

  it("preserves getters so props stay reactive", () => {
    const count = signal(0);
    const props = {
      get value() {
        return count.get();
      },
    };
    const out = withDefaults<{ value: number; label: string }>(props as never, { label: "x" });
    const seen: number[] = [];
    effect(() => seen.push(out.value));
    count.set(5);
    expect(seen).toEqual([0, 5]);
    expect(out.label).toBe("x");
  });

  it("falls back when a getter currently yields undefined", () => {
    const props = {
      get label() {
        return undefined;
      },
    };
    const out = withDefaults<{ label: string }>(props as never, { label: "default" });
    expect(out.label).toBe("default");
  });
});

describe("setAttr", () => {
  it("reactively toggles an attribute", () => {
    const el = document.createElement("button");
    const disabled = signal(false);
    setAttr(el, "disabled", () => disabled.get());
    expect(el.hasAttribute("disabled")).toBe(false);
    disabled.set(true);
    expect(el.hasAttribute("disabled")).toBe(true);
  });
});

describe("listen + mount", () => {
  it("wires events and mounts a component", () => {
    const Counter = (props: Record<string, unknown>) => {
      const count = signal(0);
      const btn = document.createElement("button");
      listen(btn, "click", () => count.set(count.get() + 1));
      insert(btn, () => `${props.label}: ${count.get()}`);
      return btn;
    };
    const root = document.createElement("div");
    mount(Counter, root, { label: "n" });
    const btn = root.querySelector("button")!;
    expect(btn.textContent).toBe("n: 0");
    btn.dispatchEvent(new Event("click"));
    expect(btn.textContent).toBe("n: 1");
  });
});

describe("hot component replacement", () => {
  it("remounts active instances when a module export is replaced", () => {
    const First = hot(() => {
      const p = document.createElement("p");
      p.textContent = "first";
      return p;
    }, "/src/App.ck", "App");
    const Second = () => {
      const p = document.createElement("p");
      p.textContent = "second";
      return p;
    };

    const root = document.createElement("div");
    const dispose = mount(First, root);
    expect(root.textContent).toBe("first");

    replaceHot("/src/App.ck", { App: Second });
    expect(root.textContent).toBe("second");

    dispose();
    expect(root.textContent).toBe("");
  });
});
