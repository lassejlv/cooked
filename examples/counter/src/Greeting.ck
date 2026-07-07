export async fn Greeting(name: string = "world") {
  const greeting = await Promise.resolve("Hello")



  rt (
    <p class="greeting">{greeting}, {name}!</p>
  )
}
