declare module "*.ck" {
  const component: (props?: Record<string, unknown>) => Node;
  export const Counter: (props?: Record<string, unknown>) => Node;
  export default component;
}
