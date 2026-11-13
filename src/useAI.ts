import { useState, useCallback, useRef } from 'react';
import { NuxxDbClient } from './index';

export function useAI(client: NuxxDbClient) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<any>(null);
  const [data, setData] = useState<string | null>(null);

  const lastRequestTime = useRef<number>(0);

  const generate = useCallback(
    async (prompt: string, systemPrompt?: string) => {
      if (!prompt) return;

      const now = Date.now();
      if (now - lastRequestTime.current < 20000) {
        setError({ message: 'Rate limit exceeded. Por favor espera 20 segundos.' });
        return;
      }

      setLoading(true);
      setError(null);
      setData(null);

      lastRequestTime.current = now;

      try {
        const url = (client as any).url;
        const headers = (client as any).headers;

        const response = await fetch(`${url}/ai/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
          body: JSON.stringify({ prompt, systemPrompt }),
        });

        const json = await response.json();

        if (!response.ok || json.error) {
          setError(json.error || { message: response.statusText });
        } else {
          setData(json.data);
        }
      } catch (e: any) {
        setError({ message: e.message });
      } finally {
        setLoading(false);
      }
    },
    [client]
  );

  return { generate, loading, error, data };
}
