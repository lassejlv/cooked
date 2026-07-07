import { expect, test } from "vitest";
import {
  buildHref,
  createRouter,
  Link,
  navigate,
  useParams,
  type RouteDefinition,
} from "../src/router.js";
import { mount } from "../src/dom.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function page(text: string | ((props: Record<string, unknown>) => string)) {
  return async () => ({
    default: (props: Record<string, unknown>) => {
      const el = document.createElement("p");
      el.textContent = typeof text === "function" ? text(props) : text;
      return el;
    },
  });
}

function makeRoutes(): RouteDefinition[] {
  return [
    { path: "/", load: page("home") },
    { path: "/about", load: page("about") },
    {
      path: "/posts/$id",
      load: page((props) => `post ${(props.params as Record<string, string>).id}`),
    },
    { path: "/posts/new", load: page("new post") },
    { path: "/docs/$", load: page((props) => `docs ${(props.params as Record<string, string>).splat}`) },
  ];
}

test("renders the matched route and navigates", async () => {
  history.pushState(null, "", "/");
  const root = document.createElement("div");
  const router = createRouter({ routes: makeRoutes() });
  const dispose = mount(router.view, root);
  await tick();
  expect(root.textContent).toBe("home");

  navigate("/about");
  await tick();
  expect(root.textContent).toBe("about");

  dispose();
  router.dispose();
  expect(root.textContent).toBe("");
});

test("params: static beats dynamic, splat catches the rest", async () => {
  history.pushState(null, "", "/posts/7");
  const root = document.createElement("div");
  const router = createRouter({ routes: makeRoutes() });
  mount(router.view, root);
  await tick();
  expect(root.textContent).toBe("post 7");

  navigate("/posts/new");
  await tick();
  expect(root.textContent).toBe("new post");

  navigate("/docs/$", { params: { splat: "guide/install" } });
  await tick();
  expect(root.textContent).toBe("docs guide/install");
  expect(useParams().get()).toEqual({ splat: "guide/install" });

  router.dispose();
});

test("layouts wrap routes, not-found renders fallback", async () => {
  history.pushState(null, "", "/nope");
  const layout = async () => ({
    default: (props: Record<string, unknown>) => {
      const el = document.createElement("section");
      el.setAttribute("class", "shell");
      const inner = props.children as Node;
      el.appendChild(inner);
      return el;
    },
  });
  const routes: RouteDefinition[] = [
    { path: "/", load: page("home"), layouts: [layout] },
  ];
  const root = document.createElement("div");
  const router = createRouter({ routes });
  mount(router.view, root);
  await tick();
  expect(root.textContent).toBe("Not found");

  navigate("/");
  await tick();
  expect(root.querySelector(".shell")?.textContent).toBe("home");

  router.dispose();
});

test("buildHref interpolates params and rejects missing ones", () => {
  history.pushState(null, "", "/");
  const router = createRouter({ routes: makeRoutes() });
  expect(buildHref("/posts/$id", { id: "a b" })).toBe("/posts/a%20b");
  expect(buildHref("/about", undefined, { q: "x" })).toBe("/about?q=x");
  expect(() => buildHref("/posts/$id")).toThrow(/missing param/);
  router.dispose();
});

test("Link renders a reactive href and navigates on click", async () => {
  history.pushState(null, "", "/");
  const root = document.createElement("div");
  const router = createRouter({ routes: makeRoutes() });
  mount(router.view, root);
  await tick();

  const a = Link({ to: "/posts/$id", params: { id: "9" }, children: "go" }) as HTMLAnchorElement;
  expect(a.getAttribute("href")).toBe("/posts/9");
  expect(a.textContent).toBe("go");

  a.dispatchEvent(new MouseEvent("click", { button: 0, cancelable: true }));
  await tick();
  expect(root.textContent).toBe("post 9");
  expect(location.pathname).toBe("/posts/9");

  router.dispose();
});
