import { createServerFn, ServerFnError } from "@cookedjs/cooked/fn";

/** Example middleware: attach timing; reject a blocked header. */
const guard = ({ request }: { request: Request | undefined }) => {
  if (request?.headers.get("x-blocked") === "1") {
    throw new ServerFnError("Blocked", 403);
  }
  return { startedAt: Date.now() };
};

export const greet = createServerFn()
  .middleware(guard)
  .validator((input: { name: string }) => {
    if (typeof input?.name !== "string" || input.name.trim().length === 0) {
      throw new ServerFnError("name is required");
    }
    if (input.name.length > 40) {
      throw new ServerFnError("name too long");
    }
    return { name: input.name.trim() };
  })
  .handler(({ input, context }) => ({
    message: `Hello, ${input.name}! (server time ${new Date().toISOString()})`,
    tookMs: Date.now() - (context.startedAt as number),
  }));
