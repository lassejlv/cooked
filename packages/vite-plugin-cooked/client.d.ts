type CookedComponent<Props extends Record<string, unknown> = Record<string, unknown>> = (
  props?: Props,
) => Node | PromiseLike<Node>;

declare module "*.ck" {
  const component: CookedComponent;
  export default component;
}

declare module "virtual:cooked-routes" {
  export const routes: import("@cookedjs/cooked/router").RouteDefinition[];
}

declare module "virtual:cooked-api-routes" {
  export const apiRoutes: import("@cookedjs/cooked/router").RouteDefinition[];
}

declare module "virtual:cooked-server-fns" {
  export const serverFns: Record<string, () => Promise<Record<string, unknown>>>;
}
