import { Link } from "@cookedjs/cooked/router"

export fn Layout() {
  rt (
    <div class="app">
      <nav>
        <Link to="/">Home</Link>
        <Link to="/about">About</Link>
      </nav>
      <main>{children}</main>
    </div>
  )
}
