// API routes live anywhere under src/routes — no `api/` folder required.
export function GET(): Response {
  return Response.json({ ok: true });
}
