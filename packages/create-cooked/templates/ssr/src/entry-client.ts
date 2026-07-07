import { mount } from "@cookedjs/cooked";
import { createRouter } from "@cookedjs/cooked/router";
import { routes } from "virtual:cooked-routes";

const app = document.getElementById("app")!;
app.innerHTML = "";
mount(createRouter({ routes }).view, app);
