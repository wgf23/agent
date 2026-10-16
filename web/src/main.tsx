import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { applyTheme, readTheme } from "./theme";

// Apply the stored theme before first paint so a light choice does not flash dark.
applyTheme(readTheme());

const container = document.getElementById("root");
if (container === null) {
	throw new Error("missing #root element");
}

createRoot(container).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
