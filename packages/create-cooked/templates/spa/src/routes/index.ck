export fn Home() {
  let mut count = 0
  let doubled => count * 2

  rt (
    <section>
      <h1>Cooked</h1>
      <button onClick={() => count += 1}>Clicked {count} times (x2 = {doubled})</button>
    </section>
  )
}
