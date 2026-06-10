type CookedComponent<Props extends Record<string, unknown> = Record<string, unknown>> = (
  props?: Props,
) => Node | PromiseLike<Node>;

declare module "*.ck" {
  const component: CookedComponent;
  export default component;
}
