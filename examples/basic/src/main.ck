export fn App() {
  let mut count = 0

  rt (
    <div>
      <button  onClick={() => count += 1}>+</button>
      <p>{count}</p>
      <button onClick={() => count -= 1}>-</button>
    </div>
  )
}
