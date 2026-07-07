export fn Post(params: { id: string }) {
  rt (
    <article class="post">
      <h1>Post {params.id}</h1>
      <p>Dynamic segment demo — this page renders for any /posts/:id.</p>
    </article>
  )
}
