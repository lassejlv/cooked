import { Counter } from "./Counter.ck";
import { TodoApp } from "./TodoApp.ck";
import { Greeting } from "./Greeting.ck";
import { mount } from "cooked";

const app = document.getElementById("app");
if (app) {
  mount(Greeting, app, { name: "cook" });
  mount(Counter, app, { label: "Count" });
  mount(TodoApp, app);
}
