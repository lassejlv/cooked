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
  let mut nextId = 0
  let remaining => todos.length

  fn add() {
    if (draft.trim() === "") return
    todos = [...todos, { id: nextId, text: draft.trim() }]
    nextId += 1
    draft = ""
  }

  fn remove(id: number) {
    todos = todos.filter(todo => todo.id !== id)
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
        <Keyed each={todos} by={todo => todo.id}>
          {todo => <TodoItem text={todo.text} onRemove={() => remove(todo.id)} />}
        </Keyed>
      </ul>
    </section>
  )
}
