import { describe, it, expect, vi } from "vitest";
import { signal, memo, effect, batch, untrack, onCleanup, createRoot } from "../src/reactive.js";

describe("signal", () => {
  it("reads and writes", () => {
    const s = signal(1);
    expect(s.get()).toBe(1);
    s.set(2);
    expect(s.get()).toBe(2);
  });

  it("does not notify on equal write", () => {
    const s = signal(1);
    const spy = vi.fn(() => s.get());
    effect(spy);
    expect(spy).toHaveBeenCalledTimes(1);
    s.set(1);
    expect(spy).toHaveBeenCalledTimes(1);
    s.set(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("effect", () => {
  it("runs immediately and re-runs on dependency change", () => {
    const s = signal(0);
    const seen: number[] = [];
    effect(() => seen.push(s.get()));
    s.set(1);
    s.set(2);
    expect(seen).toEqual([0, 1, 2]);
  });

  it("runs cleanup before re-running and on dispose", () => {
    const s = signal(0);
    const cleaned: number[] = [];
    const dispose = effect(() => {
      const v = s.get();
      onCleanup(() => cleaned.push(v));
    });
    s.set(1); // cleans up 0
    s.set(2); // cleans up 1
    dispose(); // cleans up 2
    expect(cleaned).toEqual([0, 1, 2]);
  });

  it("stops reacting after dispose", () => {
    const s = signal(0);
    const spy = vi.fn(() => s.get());
    const dispose = effect(spy);
    dispose();
    s.set(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("memo", () => {
  it("derives and caches", () => {
    const s = signal(2);
    const doubled = memo(() => s.get() * 2);
    expect(doubled.get()).toBe(4);
    s.set(5);
    expect(doubled.get()).toBe(10);
  });

  it("propagates through to dependent effects (diamond)", () => {
    const a = signal(1);
    const b = memo(() => a.get() + 1);
    const c = memo(() => a.get() + 10);
    const seen: number[] = [];
    effect(() => seen.push(b.get() + c.get()));
    a.set(2);
    // b: 3, c: 12 -> 15 ; initial 1->2,11 = 13
    expect(seen[seen.length - 1]).toBe(15);
  });
});

describe("batch", () => {
  it("flushes once for multiple writes", () => {
    const a = signal(1);
    const b = signal(2);
    const spy = vi.fn(() => a.get() + b.get());
    effect(spy);
    expect(spy).toHaveBeenCalledTimes(1);
    batch(() => {
      a.set(10);
      b.set(20);
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("ownership", () => {
  it("disposes nested effects when the owner re-runs", () => {
    const outer = signal(0);
    const inner = signal(0);
    const spy = vi.fn(() => inner.get());
    effect(() => {
      outer.get();
      effect(spy); // recreated per outer run; the old one must die
    });
    expect(spy).toHaveBeenCalledTimes(1);
    inner.set(1);
    expect(spy).toHaveBeenCalledTimes(2);
    outer.set(1); // re-run outer: old inner effect disposed, new one created
    expect(spy).toHaveBeenCalledTimes(3);
    inner.set(2); // only the new inner effect reacts
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("disposes nested effects when the owner is disposed", () => {
    const inner = signal(0);
    const spy = vi.fn(() => inner.get());
    const dispose = effect(() => {
      effect(spy);
    });
    dispose();
    inner.set(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("createRoot owns effects without tracking reads", () => {
    const s = signal(0);
    const spy = vi.fn(() => s.get());
    let rootRuns = 0;
    const dispose = createRoot((dispose) => {
      rootRuns++;
      s.get(); // must NOT subscribe the root
      effect(spy);
      return dispose;
    });
    s.set(1);
    expect(rootRuns).toBe(1);
    expect(spy).toHaveBeenCalledTimes(2);
    dispose();
    s.set(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("runs onCleanup registered during component setup on root dispose", () => {
    const cleaned = vi.fn();
    const dispose = createRoot((dispose) => {
      onCleanup(cleaned);
      return dispose;
    });
    expect(cleaned).not.toHaveBeenCalled();
    dispose();
    expect(cleaned).toHaveBeenCalledTimes(1);
  });
});

describe("untrack", () => {
  it("reads without subscribing", () => {
    const a = signal(1);
    const b = signal(1);
    const spy = vi.fn(() => a.get() + untrack(() => b.get()));
    effect(spy);
    b.set(5);
    expect(spy).toHaveBeenCalledTimes(1); // b not tracked
    a.set(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
