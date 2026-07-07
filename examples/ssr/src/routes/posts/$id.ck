import { createServerFn } from "@cookedjs/cooked/fn"

export const likePost = createServerFn()
  .validator((input: { id: string }) => {
    if (typeof input?.id !== "string") throw new Error("id required")
    return input
  })
  .handler(({ input }) => ({ liked: input.id }))

export fn Post(params: { id: string }) {
  rt (
    <article class="post">
      <h1>Post {params.id}</h1>
      <p>Rendered on the server for any /posts/:id.</p>
    </article>
  )
}
