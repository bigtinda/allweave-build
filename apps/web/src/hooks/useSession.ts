import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { applyEvent, type SessionDetail, type SocketMessage } from "../../../shared/src/protocol.ts";
import { api } from "../services/api.ts";

export function useSession(id: string | undefined) {
	const client = useQueryClient();
	const [connection, setConnection] = useState("连接中");
	const query = useQuery({
		queryKey: ["session", id],
		gcTime: 0,
		structuralSharing: false,
		enabled: !!id,
		queryFn: async () => {
			const fetched = await api<SessionDetail>(`/sessions/${id}`);
			const current = client.getQueryData<SessionDetail>(["session", id]);
			return current && current.sequence > fetched.sequence ? current : fetched;
		},
	});
	useEffect(() => {
		if (!id) return;
		let active = true;
		let socket: WebSocket;
		let timer: ReturnType<typeof setTimeout>;
		let attempt = 0;
		const connect = () => {
			if (!active) return;
			setConnection(attempt ? "重新连接中" : "连接中");
			socket = new WebSocket(
				`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/sessions/${id}`,
			);
			socket.onopen = () => {
				attempt = 0;
				setConnection("已连接");
			};
			socket.onmessage = (event) => {
				if (!active) return;
				const message = JSON.parse(String(event.data)) as SocketMessage;
				client.setQueryData<SessionDetail>(["session", id], (previous) => {
					if (message.type === "session.snapshot")
						return !previous || message.session.sequence >= previous.sequence ? message.session : previous;
					return previous ? applyEvent(previous, message) : previous;
				});
				if (message.type !== "message.delta" && message.type !== "tool.updated") {
					void client.invalidateQueries({ queryKey: ["sessions"] });
				}
				if (message.type === "tool.completed") {
					void client.invalidateQueries({ queryKey: ["files"] });
					if (message.tool?.name === "plugin_install") {
						void client.invalidateQueries({ queryKey: ["app-plugins"] });
					}
				}
			};
			socket.onclose = () => {
				if (!active) return;
				setConnection("连接已断开，正在重试");
				timer = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 15_000));
			};
			socket.onerror = () => socket.close();
		};
		connect();
		return () => {
			active = false;
			clearTimeout(timer);
			socket?.close();
		};
	}, [id, client]);
	return { ...query, connection };
}
