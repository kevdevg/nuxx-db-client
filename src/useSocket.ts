import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import type { ManagerOptions, SocketOptions } from 'socket.io-client';

export interface UseSocketOptions {
  url: string;
  namespace?: string;
  query?: Record<string, string>;
  options?: Partial<ManagerOptions & SocketOptions>;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onMessage?: (msg: any) => void;
  autoConnect?: boolean;
}

export interface UseSocketReturn {
  socket: Socket | null;
  isConnected: boolean;
  sendMsg: (data: any) => void;
  emit: (event: string, ...args: any[]) => void;
}

export function useSocket({
  url,
  namespace = '',
  query,
  options = {},
  onConnect,
  onDisconnect,
  onMessage,
  autoConnect = true,
}: UseSocketOptions): UseSocketReturn {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  // Mantenemos referencias frescas de los callbacks
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  const onMessageRef = useRef(onMessage);

  useEffect(() => {
    onConnectRef.current = onConnect;
    onDisconnectRef.current = onDisconnect;
    onMessageRef.current = onMessage;
  });

  useEffect(() => {
    if (!autoConnect || !url) return;

    const nspUrl = namespace
      ? `${url}${namespace.startsWith('/') ? namespace : `/${namespace}`}`
      : url;

    const socket = io(nspUrl, {
      query,
      ...options,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      onConnectRef.current?.();
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
      onDisconnectRef.current?.();
    });

    socket.on('message', (msg: any) => {
      onMessageRef.current?.(msg);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, namespace, autoConnect, JSON.stringify(query)]);

  const sendMsg = useCallback((data: any) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('message', data);
    }
  }, []);

  const emit = useCallback((event: string, ...args: any[]) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit(event, ...args);
    }
  }, []);

  return {
    socket: socketRef.current,
    isConnected,
    sendMsg,
    emit,
  };
}
