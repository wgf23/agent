import { useEffect, useState } from "react";
import type { AllowAll } from "../permissions/allow-all.js";

export function useAllowAllState(allowAll: AllowAll): boolean {
	const [on, setOn] = useState(() => allowAll.get());
	useEffect(
		() => allowAll.subscribe((state) => setOn(state.mode !== "off")),
		[allowAll],
	);
	return on;
}
