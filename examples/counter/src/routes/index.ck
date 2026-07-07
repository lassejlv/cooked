import { Greeting } from "../Greeting.ck"

export fn Home() {
  rt (
    <section class="home">
      <Greeting name="cook" />
      <p>Welcome to the Cooked router example.</p>
    </section>
  )
}
