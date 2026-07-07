import type { ApiContext } from "@cookedjs/cooked/server";

export function GET(_request: Request, { params }: ApiContext): Response {
  return Response.json({ id: params.id, title: `Post ${params.id}` });
}
