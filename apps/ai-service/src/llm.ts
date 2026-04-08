// ===== LLM Adapter =====
// Connects to user's own LLM API (OpenAI-compatible format)
// Configure via .env: LLM_API_URL, LLM_API_KEY, LLM_MODEL

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface LLMConfig {
    apiUrl: string;
    apiKey: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
}

const config: LLMConfig = {
    apiUrl: process.env.LLM_API_URL || 'http://localhost:11434/v1/chat/completions',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'llama3',
    temperature: parseFloat(process.env.LLM_TEMPERATURE || '0.3'),
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS || '2048'),
};

export async function callLLM(messages: ChatMessage[], options?: Partial<LLMConfig>): Promise<string> {
    const cfg = { ...config, ...options };

    try {
        const response = await fetch(cfg.apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(cfg.apiKey ? { 'Authorization': `Bearer ${cfg.apiKey}` } : {}),
            },
            body: JSON.stringify({
                model: cfg.model,
                messages,
                temperature: cfg.temperature,
                max_tokens: cfg.maxTokens,
                stream: false,
            }),
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`LLM API error (${response.status}): ${err}`);
        }

        const data: any = await response.json();

        // OpenAI format
        if (data.choices?.[0]?.message?.content) {
            return data.choices[0].message.content;
        }
        // Ollama format
        if (data.message?.content) {
            return data.message.content;
        }
        // Fallback
        if (typeof data.response === 'string') {
            return data.response;
        }

        throw new Error('Unexpected LLM response format: ' + JSON.stringify(data).slice(0, 200));
    } catch (error: any) {
        console.error('[LLM] Error:', error.message);
        throw error;
    }
}

export async function streamLLM(
    messages: ChatMessage[],
    onChunk: (text: string) => void,
    options?: Partial<LLMConfig>
): Promise<void> {
    const cfg = { ...config, ...options };

    const response = await fetch(cfg.apiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(cfg.apiKey ? { 'Authorization': `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
            model: cfg.model,
            messages,
            temperature: cfg.temperature,
            max_tokens: cfg.maxTokens,
            stream: true,
        }),
    });

    if (!response.ok) throw new Error(`LLM API error: ${response.status}`);
    if (!response.body) throw new Error('No response body for streaming');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(l => l.startsWith('data: '));

        for (const line of lines) {
            const data = line.slice(6);
            if (data === '[DONE]') return;
            try {
                const parsed = JSON.parse(data);
                const text = parsed.choices?.[0]?.delta?.content || '';
                if (text) onChunk(text);
            } catch { }
        }
    }
}

export function getLLMConfig(): LLMConfig {
    return { ...config };
}
