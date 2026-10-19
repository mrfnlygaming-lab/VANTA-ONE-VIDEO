import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { configureRuntime } from "./runtime";
import { browserRequest } from "./browser-engine";
import "./styles.css";

declare const __VANTA_EXAMPLE__: string;

configureRuntime({
  standalone: true,
  exampleImage: __VANTA_EXAMPLE__,
  request: browserRequest,
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
