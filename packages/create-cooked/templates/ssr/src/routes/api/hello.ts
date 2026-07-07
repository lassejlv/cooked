// API routes: any .ts file under src/routes. GET /api/hello?name=x
export function GET(request: Request): Response {
  const name = new URL(request.url).searchParams.get("name") ?? "world";
  return Response.json({ hello: name });
}
