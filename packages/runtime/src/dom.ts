/**
 * DOM helpers — the imperative surface the Cooked compiler targets.
 *
 * The compiler emits `document.createElement(...)` trees and wires the dynamic
 * spots through these functions, each of which opens a fine-grained `effect`.
 * No virtual DOM: an update touches only the node it owns.
 */

import { createRoot, effect } from "./reactive.js";

type Child = Node | string | number | boolean | null | undefined | Child[];
type Component = (props: Record<string, unknown>) => Node | PromiseLike<Node>;

const DOCUMENT_FRAGMENT_NODE = 11;
const hotMeta = new WeakMap<Component, { id: string; name: string }>();
const hotInstances = new Map<string, Set<HotInstance>>();

interface HotInstance {
  rerender(component: Component): void;
}

// nodeType checks instead of instanceof: they hold across realms (and DOM
// shims whose instances don't satisfy instanceof, like happy-dom fragments).
function isNode(value: object): value is Node {
  return "nodeType" in value;
}

function isFragment(value: Node): boolean {
  return value.nodeType === DOCUMENT_FRAGMENT_NODE;
}

function normalize(value: Child): Node[] {
  if (value == null || value === false || value === true) return [];
  if (Array.isArray(value)) return value.flatMap(normalize);
  if (typeof value === "object" && isNode(value)) {
    // A fragment's children scatter on insertion and the (then-empty) fragment
    // can't remove them later — track the children themselves instead.
    if (isFragment(value)) return [...value.childNodes];
    return [value];
  }
  return [document.createTextNode(String(value))];
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Reactively render the result of `accessor` into `parent` before `marker`. */
export function insert(
  parent: Node,
  accessor: () => Child | PromiseLike<Child>,
  marker: Node | null = null,
): void {
  let current: Node[] = [];
  let token = 0;
  const apply = (next: Node[]) => {
    for (const node of current) {
      node.parentNode?.removeChild(node);
    }
    // The marker may have moved (e.g. built inside a fragment that has since
    // been inserted) — follow it rather than the original parent.
    const host = marker?.parentNode ?? parent;
    for (const node of next) host.insertBefore(node, marker);
    current = next;
  };
  effect(() => {
    const value = accessor();
    const t = ++token;
    if (isThenable(value)) {
      // Render when resolved, unless a newer value has won the race.
      void value.then((v) => {
        if (t === token) apply(normalize(v));
      });
    } else {
      apply(normalize(value));
    }
  });
}

/**
 * Reactively render a keyed list. Existing keyed nodes are moved instead of
 * rebuilt, and removed keys dispose the effects created while rendering them.
 */
export function keyed<T, K extends PropertyKey>(
  parent: Node,
  items: () => readonly T[],
  key: (item: T, index: number) => K,
  render: (item: T, index: number) => Child,
  marker: Node | null = null,
): void {
  interface Entry {
    nodes: Node[];
    dispose: () => void;
  }

  let entries = new Map<K, Entry>();
  effect(() => {
    const nextEntries = new Map<K, Entry>();
    const nextItems = items();
    const host = marker?.parentNode ?? parent;

    nextItems.forEach((item, index) => {
      const k = key(item, index);
      let entry = entries.get(k);
      if (!entry) {
        entry = createRoot((dispose) => ({
          nodes: normalize(render(item, index)),
          dispose,
        }));
      }
      nextEntries.set(k, entry);
      for (const node of entry.nodes) host.insertBefore(node, marker);
    });

    for (const [k, entry] of entries) {
      if (nextEntries.has(k)) continue;
      entry.dispose();
      for (const node of entry.nodes) node.parentNode?.removeChild(node);
    }

    entries = nextEntries;
  });
}

/**
 * Append a child that may be an async component's `Promise<Node>`. A comment
 * marker holds its place so siblings keep their order while it loads.
 */
export function append(parent: Node, value: Child | PromiseLike<Child>): void {
  if (isThenable(value)) {
    const marker = document.createComment("");
    parent.appendChild(marker);
    void value.then((v) => {
      const host = marker.parentNode;
      if (!host) return; // detached before it resolved
      for (const node of normalize(v)) host.insertBefore(node, marker);
    });
    return;
  }
  for (const node of normalize(value)) parent.appendChild(node);
}

/** Reactively set (or remove) an attribute. */
export function setAttr(el: Element, name: string, accessor: () => unknown): void {
  effect(() => {
    const v = accessor();
    if (v == null || v === false) el.removeAttribute(name);
    else if (v === true) el.setAttribute(name, "");
    else el.setAttribute(name, String(v));
  });
}

/** Set a static attribute once (no effect). */
export function attr(el: Element, name: string, value: unknown): void {
  if (value == null || value === false) return;
  el.setAttribute(name, value === true ? "" : String(value));
}

/** Reactively set a DOM property (`value`, `checked`, ...). */
export function setProp(el: Element, name: string, accessor: () => unknown): void {
  const target = el as unknown as Record<string, unknown>;
  effect(() => {
    const v = accessor();
    // Skipping no-op writes keeps the caret stable in focused inputs.
    if (target[name] !== v) target[name] = v;
  });
}

/** Reactively apply styles: a cssText string or a {property: value} object. */
export function setStyle(el: ElementCSSInlineStyle, accessor: () => unknown): void {
  let prevKeys: string[] = [];
  effect(() => {
    const v = accessor();
    if (v == null || typeof v === "string") {
      el.style.cssText = (v as string) ?? "";
      prevKeys = [];
      return;
    }
    const styles = v as Record<string, string | number | null | undefined>;
    const style = el.style as unknown as Record<string, unknown>;
    for (const key of prevKeys) {
      if (!(key in styles)) style[key] = "";
    }
    for (const [key, value] of Object.entries(styles)) {
      style[key] = value == null ? "" : value;
    }
    prevKeys = Object.keys(styles);
  });
}

/** Attach an event listener. */
export function listen(el: Element, type: string, handler: EventListenerOrEventListenerObject): void {
  el.addEventListener(type, handler);
}

/**
 * Apply prop defaults. Compiler-passed props use getters to stay reactive;
 * descriptors are copied (not read) so no subscription is made here and
 * getters keep working on the merged object.
 */
export function withDefaults<T extends object>(props: Partial<T>, defaults: Partial<T>): T {
  const out: Record<string, unknown> = {};
  const source = (props ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const desc = Object.getOwnPropertyDescriptor(source, key)!;
    Object.defineProperty(out, key, { ...desc, configurable: true });
  }
  for (const [key, fallback] of Object.entries(defaults)) {
    const desc = Object.getOwnPropertyDescriptor(out, key);
    if (!desc) {
      out[key] = fallback;
    } else if (desc.get) {
      const get = desc.get;
      Object.defineProperty(out, key, {
        get: () => {
          const v = get();
          return v === undefined ? fallback : v;
        },
        enumerable: true,
        configurable: true,
      });
    } else if (desc.value === undefined) {
      out[key] = fallback;
    }
  }
  return out as T;
}

/** Attach dev-only HMR identity to a compiled component function. */
export function hot<T extends Component>(component: T, id: string, name: string): T {
  hotMeta.set(component, { id, name });
  return component;
}

/** Replace mounted instances for the updated module exports. */
export function replaceHot(id: string, mod: Record<string, unknown> | undefined): void {
  if (!mod) return;
  for (const [key, instances] of hotInstances) {
    if (!key.startsWith(`${id}:`)) continue;
    const name = key.slice(id.length + 1);
    const next = mod[name];
    if (typeof next !== "function") continue;
    const component = hot(next as Component, id, name);
    for (const instance of [...instances]) instance.rerender(component);
  }
}

/**
 * Mount a component into a target element. Runs under a fresh ownership root;
 * the returned disposer tears down every effect and removes the rendered nodes.
 * Async components (`Promise<Node>`) render when they resolve.
 */
export function mount(
  component: Component,
  target: Element,
  props: Record<string, unknown> = {},
): () => void {
  let activeComponent = component;
  let disposeRoot = () => {};
  let nodes: Node[] = [];
  let disposed = false;
  let version = 0;

  const removeNodes = () => {
    for (const n of nodes) {
      if (n.parentNode === target) target.removeChild(n);
    }
    nodes = [];
  };

  const render = (nextComponent = activeComponent) => {
    activeComponent = nextComponent;
    version++;
    const current = version;
    disposeRoot();
    removeNodes();
    createRoot((dispose) => {
      disposeRoot = dispose;
      const result = activeComponent(props);
      const add = (node: Node) => {
        if (disposed || current !== version) return;
        nodes = isFragment(node) ? [...node.childNodes] : [node];
        target.appendChild(node);
      };
      if (isThenable(result)) {
        void result.then((node) => add(node as Node));
      } else {
        add(result);
      }
    });
  };

  const meta = hotMeta.get(component);
  const hotKey = meta ? `${meta.id}:${meta.name}` : null;
  const instance: HotInstance = { rerender: render };
  if (hotKey) {
    let set = hotInstances.get(hotKey);
    if (!set) {
      set = new Set();
      hotInstances.set(hotKey, set);
    }
    set.add(instance);
  }

  render();

  return () => {
    disposed = true;
    if (hotKey) {
      const set = hotInstances.get(hotKey);
      set?.delete(instance);
      if (set?.size === 0) hotInstances.delete(hotKey);
    }
    version++;
    disposeRoot();
    removeNodes();
  };
}
