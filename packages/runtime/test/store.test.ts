import { describe, expect, it, vi } from "vitest";
import { effect } from "../src/reactive.js";
import { atom, createActions, createStore } from "../src/store.js";

describe("createStore", () => {
  it("reads, sets, updates and patches state", () => {
    const store = createStore({ count: 0, label: "cook" });

    expect(store.get()).toEqual({ count: 0, label: "cook" });
    store.set({ count: 1, label: "cook" });
    expect(store.get().count).toBe(1);
    store.update((state) => ({ ...state, count: state.count + 1 }));
    expect(store.get().count).toBe(2);
    store.patch({ label: "done" });
    expect(store.get()).toEqual({ count: 2, label: "done" });
  });

  it("selects slices and only notifies when the slice changes", () => {
    const store = createStore({ count: 0, text: "a" });
    const count = store.select((state) => state.count);
    const spy = vi.fn(() => count.get());

    effect(spy);
    expect(spy).toHaveBeenCalledTimes(1);
    store.patch({ text: "b" });
    expect(spy).toHaveBeenCalledTimes(1);
    store.patch({ count: 1 });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("supports custom equality for selected slices", () => {
    const store = createStore({ items: ["a"] });
    const items = store.select(
      (state) => state.items,
      (a, b) => a.length === b.length,
    );
    const spy = vi.fn(() => items.get());

    effect(spy);
    store.patch({ items: ["b"] });
    expect(spy).toHaveBeenCalledTimes(1);
    store.patch({ items: ["b", "c"] });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("subscribes to whole state or selected slices", () => {
    const store = createStore({ count: 0, text: "a" });
    const all = vi.fn();
    const selected = vi.fn();

    const stopAll = store.subscribe(all);
    const stopSelected = store.subscribe((state) => state.count, selected);

    store.patch({ text: "b" });
    expect(all).toHaveBeenCalledTimes(1);
    expect(selected).not.toHaveBeenCalled();

    store.patch({ count: 1 });
    expect(all).toHaveBeenCalledTimes(2);
    expect(selected).toHaveBeenCalledWith(1, 0);

    stopAll();
    stopSelected();
    store.patch({ count: 2 });
    expect(all).toHaveBeenCalledTimes(2);
    expect(selected).toHaveBeenCalledTimes(1);
  });

  it("creates ergonomic actions around a store", () => {
    const store = createStore({ count: 0 });
    const actions = createActions(store, ({ patch, get }) => ({
      inc() {
        patch({ count: get().count + 1 });
      },
    }));

    actions.inc();
    actions.inc();
    expect(store.get().count).toBe(2);
  });
});

describe("atom", () => {
  it("is a tiny writable signal alias for local state", () => {
    const count = atom(0);
    count.set(1);
    expect(count.get()).toBe(1);
  });
});
