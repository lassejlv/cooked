import type { ApiContext } from "@cookedjs/cooked/server";

export function GET(request: Request, _context: ApiContext): Response {
  const name = new URL(request.url).searchParams.get("name") ?? "world";
  return Response.json({ hello: name });
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.json();
  return Response.json({ received: body }, { status: 201 });
}
