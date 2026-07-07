import { createServerFn, ServerFnError } from "@cookedjs/cooked/fn";

export const greet = createServerFn()
  .validator((input: { name: string }) => {
    if (typeof input?.name !== "string" || !input.name.trim()) {
      throw new ServerFnError("name is required");
    }
    return { name: input.name.trim() };
  })
  .handler(({ input }) => ({ message: `Hello, ${input.name}! (from the server)` }));
