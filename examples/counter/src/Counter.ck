export fn Counter(label: string = "Count") {
  let mut count = 0
  let doubled => count * 2

  effect {
    console.log("count is", count)
  }

  fn inc() {
    count += 1
  }

  rt (
    <div class="counter">
      <h1>{label}: {count} (x2 = {doubled})</h1>
      <button onClick={inc}>+</button>

      <footer>
        <p style="color: red;">Count: {count}</p>
      </footer>
    </div>
  )
}
