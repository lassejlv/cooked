import "./style.css";
import { mount } from "@cookedjs/cooked";
import { createRouter } from "@cookedjs/cooked/router";
import { routes } from "virtual:cooked-routes";

const app = document.getElementById("app");

if (app) {
  const router = createRouter({ routes });
  mount(router.view, app);
}
