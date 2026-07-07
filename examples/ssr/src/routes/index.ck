import { greet } from "../functions/greet.server"

export fn Home() {
  let mut clicks = 0
  let mut serverMessage = ""

  async fn callServer() {
    const result = await greet({ name: "cook" })
    serverMessage = result.message
  }

  rt (
    <section class="home">
      <h1>Server-rendered Cooked</h1>
      <p>This page arrives as HTML from the server, then the client takes over.</p>
      <button onClick={() => clicks += 1}>Clicked {clicks} times</button>
      <button class="rpc" onClick={callServer}>Call server function</button>
      {serverMessage && <p class="server-message">{serverMessage}</p>}
    </section>
  )
}
