import { Link } from "cooked/router"

export fn Layout() {
  rt (
    <div class="app mx-auto max-w-2xl p-6">
      <nav class="nav mb-6 flex gap-4 border-b border-gray-200 pb-3">
        <Link to="/" class="font-medium text-blue-600 hover:underline">Home</Link>
        <Link to="/counter" class="font-medium text-blue-600 hover:underline">Counter</Link>
        <Link to="/todos" class="font-medium text-blue-600 hover:underline">Todos</Link>
        <Link to="/posts/$id" params={{ id: "42" }} class="font-medium text-blue-600 hover:underline">Post 42</Link>
      </nav>
      <main>{children}</main>
    </div>
  )
}
