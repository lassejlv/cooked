import { mount } from "@cookedjs/cooked";
import { App } from "./main.ck";

const app = document.getElementById("app");

if (app) {
  mount(App, app);
}
