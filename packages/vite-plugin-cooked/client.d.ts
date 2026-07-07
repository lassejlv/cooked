type CookedComponent<Props extends Record<string, unknown> = Record<string, unknown>> = (
  props?: Props,
) => Node | PromiseLike<Node>;

declare module "*.ck" {
  const component: CookedComponent;
  export default component;
}

declare module "virtual:cooked-routes" {
  export const routes: import("cooked/router").RouteDefinition[];
}
