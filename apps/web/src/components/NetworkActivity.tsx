import { LinearProgress } from "@mui/material";
import { useIsFetching } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { getRequestActivity, subscribeRequestActivity } from "../services/request-activity.ts";

export function NetworkActivity() {
	const actions = useSyncExternalStore(subscribeRequestActivity, getRequestActivity, getRequestActivity);
	const queries = useIsFetching();
	const busy = actions > 0 || queries > 0;
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		if (!busy) {
			setVisible(false);
			return;
		}
		const timer = window.setTimeout(() => setVisible(true), 150);
		return () => window.clearTimeout(timer);
	}, [busy]);
	return (
		<div className="network-activity">{busy && visible && <LinearProgress aria-label="正在加载或处理操作" />}</div>
	);
}
