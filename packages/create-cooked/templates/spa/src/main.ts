import { mount } from "@cookedjs/cooked";
import { createRouter } from "@cookedjs/cooked/router";
import { routes } from "virtual:cooked-routes";

mount(createRouter({ routes }).view, document.getElementById("app")!);
