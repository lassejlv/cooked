import { mount } from "@cookedjs/cooked";
import { createRouter } from "@cookedjs/cooked/router";
import { routes } from "virtual:cooked-routes";

const app = document.getElementById("app");

if (app) {
  const router = createRouter({ routes });
  // Takeover: drop the server markup and mount the live client render.
  app.innerHTML = "";
  mount(router.view, app);
}
