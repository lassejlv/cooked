export fn TodoItem(text: string, onRemove) {
  rt (
    <li class="todo">
      <span>{text}</span>
      <button class="remove" onClick={onRemove}>x</button>
    </li>
  )
}

export fn TodoApp() {
  let mut todos = []
  let mut draft = ""
  let remaining => todos.length

  fn add() {
    if (draft.trim() === "") return
    todos = [...todos, draft.trim()]
    draft = ""
  }

  fn remove(index: number) {
    todos = todos.filter((_, i) => i !== index)
  }

  rt (
    <section class="todo-app">
      <h1>Todos ({remaining})</h1>
      <form onSubmit={e => { e.preventDefault(); add() }}>
        <input
          placeholder="What needs doing?"
          value={draft}
          onInput={e => draft = e.target.value}
        />
        <button type="submit" disabled={draft.trim() === ""}>Add</button>
      </form>
      {todos.length === 0 && <p class="empty">Nothing to do — enjoy your day</p>}
      <ul>
        {todos.map((text, i) => <TodoItem text={text} onRemove={() => remove(i)} />)}
      </ul>
    </section>
  )
}
