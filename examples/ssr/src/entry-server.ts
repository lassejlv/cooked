import { renderToString, type RenderResult } from "@cookedjs/cooked/server";
import { routes } from "virtual:cooked-routes";

export function render(url: string): Promise<RenderResult> {
  return renderToString(routes, url);
}
