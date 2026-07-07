import "./style.css";
import { mount } from "cooked";
import { createRouter } from "cooked/router";
import { routes } from "virtual:cooked-routes";

const app = document.getElementById("app");

if (app) {
  const router = createRouter({ routes });
  mount(router.view, app);
}
