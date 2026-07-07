import { greet } from "../functions/greet.server"

export fn Home() {
  let mut count = 0
  let mut message = ""

  async fn callServer() {
    const result = await greet({ name: "cook" })
    message = result.message
  }

  rt (
    <section>
      <h1>Cooked SSR</h1>
      <p>This page is server-rendered; the client takes over on load.</p>
      <button onClick={() => count += 1}>Clicked {count} times</button>
      <button onClick={callServer}>Call server function</button>
      {message && <p>{message}</p>}
    </section>
  )
}
