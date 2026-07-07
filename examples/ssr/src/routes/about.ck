import { APP_NAME, serverStats } from "../lib/stats"

export fn About() {
  let mut stats = ""

  async fn load() {
    const result = await serverStats()
    stats = `node ${result.node}, up ${result.uptimeSeconds}s`
  }

  rt (
    <section class="about">
      <h1>About {APP_NAME}</h1>
      <p>Minimal SSR: file-based routes, rendered on the server, interactive on the client.</p>
      <button class="stats" onClick={load}>Load server stats</button>
      {stats && <p class="stats-result">{stats}</p>}
    </section>
  )
}
