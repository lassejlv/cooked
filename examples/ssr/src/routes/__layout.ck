import { Link } from "@cookedjs/cooked/router"

export fn Layout() {
  rt (
    <div class="app">
      <nav class="nav">
        <Link to="/">Home</Link>
        <Link to="/about">About</Link>
        <Link to="/posts/$id" params={{ id: "42" }}>Post 42</Link>
      </nav>
      <main>{children}</main>
    </div>
  )
}
