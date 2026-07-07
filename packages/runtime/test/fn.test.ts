import { expect, test } from "vitest";
import { createServerFn, ServerFnError, type ServerFn } from "../src/fn.js";

test("runs middleware -> validator -> handler with merged context", async () => {
  const order: string[] = [];
  const fn = createServerFn()
    .middleware(() => {
      order.push("mw1");
      return { a: 1 };
    })
    .middleware(() => {
      order.push("mw2");
      return { b: 2 };
    })
    .validator((input: { x: number }) => {
      order.push("validate");
      return { x: input.x * 2 };
    })
    .handler(({ input, context }) => {
      order.push("handler");
      return { x: input.x, ...context };
    });

  const result = await fn({ x: 21 });
  expect(result).toEqual({ x: 42, a: 1, b: 2 });
  expect(order).toEqual(["mw1", "mw2", "validate", "handler"]);
});

test("without a validator the handler never sees the raw payload", async () => {
  const fn = createServerFn().handler(({ input }) => ({ input }));
  const runnable = fn as ServerFn<undefined, { input: undefined }>;
  const viaHttp = await runnable.__run({ evil: "payload" });
  expect(viaHttp).toEqual({ input: undefined });
});

test("validator failures throw ServerFnError with status", async () => {
  const fn = createServerFn()
    .validator((input: { name: string }) => {
      if (!input?.name) throw new ServerFnError("name required");
      return input;
    })
    .handler(({ input }) => input);
  await expect(fn({ name: "" })).rejects.toMatchObject({
    name: "ServerFnError",
    status: 400,
  });
});

test("middleware can reject with a status", async () => {
  const fn = createServerFn()
    .middleware(() => {
      throw new ServerFnError("nope", 403);
    })
    .handler(() => "unreachable");
  await expect(fn()).rejects.toMatchObject({ status: 403 });
});
