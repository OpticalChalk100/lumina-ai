/**
 * Lumina AI — Hugging Face Inference Providers API Service
 *
 * Uses the new OpenAI-compatible Inference Providers endpoint:
 *   https://router.huggingface.co/v1/chat/completions
 *
 * This replaces the deprecated api-inference.huggingface.co endpoint and
 * eliminates all manual prompt-template formatting.
 */

// Helper: sleep for ms milliseconds
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─────────────────────────────────────────────────────────────
// Token Validation
// ─────────────────────────────────────────────────────────────

/**
 * Validates a Hugging Face API token.
 *
 * Strategy:
 *  1. Local format check — instant, no network needed.
 *  2. Optional network ping — catches revoked tokens; gracefully degrades
 *     on CORS/file-protocol blocks.
 *
 * @param {string} token - Raw token string from the user
 * @returns {Promise<{isValid: boolean, username?: string, error?: string}>}
 */
export async function validateToken(token) {
    if (!token) {
        return { isValid: false, error: 'Token is empty.' };
    }

    // Strip accidental 'Bearer ' prefix
    let sanitizedToken = token.trim();
    if (sanitizedToken.toLowerCase().startsWith('bearer ')) {
        sanitizedToken = sanitizedToken.substring(7).trim();
    }

    // ── Step 1: Instant local format check ──────────────────────────────────
    // All HF tokens start with 'hf_' and are at least 13 characters total.
    const HF_TOKEN_REGEX = /^hf_[a-zA-Z0-9]{10,}$/;
    if (!HF_TOKEN_REGEX.test(sanitizedToken)) {
        return {
            isValid: false,
            error: 'Invalid token format. Hugging Face tokens start with "hf_" and are at least 13 characters long.'
        };
    }

    // ── Step 2: Optional network ping via the new router endpoint ────────────
    // We send a minimal chat request. If the network call itself fails (CORS,
    // file:// protocol, no internet), we fall back to format-based validation.
    // Only an explicit 401 / 403 response definitively invalidates the token.
    try {
        const response = await fetch('https://router.huggingface.co/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${sanitizedToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'meta-llama/Llama-3.1-8B-Instruct:novita',
                messages: [{ role: 'user', content: 'hi' }],
                max_tokens: 1
            })
        });

        if (response.status === 401 || response.status === 403) {
            return {
                isValid: false,
                error: 'Invalid or revoked API token. Please generate a new one at huggingface.co/settings/tokens with "Make calls to Inference Providers" permission enabled.'
            };
        }

        // Any other status (200, 402, 429, 5xx) means auth passed ✓
        return { isValid: true, username: 'HF Developer' };

    } catch (_networkError) {
        // Blocked by CORS / file:// / offline — trust the format check
        console.warn('Token network ping blocked — using format-based validation.', _networkError);
        return { isValid: true, username: 'HF Developer' };
    }
}


// ─────────────────────────────────────────────────────────────
// Chat Inference via Inference Providers Router
// ─────────────────────────────────────────────────────────────

/**
 * Sends a chat prompt to a Hugging Face Inference Provider model using the
 * OpenAI-compatible /v1/chat/completions endpoint.
 *
 * @param {object}   params
 * @param {string}   params.token        - HF API token
 * @param {string}   params.modelId      - Model ID (e.g. "meta-llama/Llama-3.2-3B-Instruct")
 * @param {string}   params.systemPrompt - System personality prompt
 * @param {Array}    params.messages      - Chat history [{role, content}, ...]
 * @param {number}   params.temperature  - 0.1–1.5
 * @param {number}   params.maxTokens    - 128–4096
 * @param {AbortSignal} params.signal    - AbortController signal
 * @param {function} params.onWarmUp     - Called with estimated seconds when model is loading
 * @returns {Promise<string>}            - The assistant reply text
 */
export async function queryChatbot({
    token,
    modelId,
    systemPrompt,
    messages,
    temperature = 0.7,
    maxTokens = 1024,
    signal,
    onWarmUp
}) {
    const ENDPOINT = 'https://router.huggingface.co/v1/chat/completions';

    // Build the OpenAI-style messages array
    const chatMessages = [
        { role: 'system', content: systemPrompt },
        ...messages.map(m => ({
            role: m.role === 'ai' ? 'assistant' : m.role,
            content: m.content
        }))
    ];

    const payload = {
        model: modelId,
        messages: chatMessages,
        temperature: parseFloat(temperature),
        max_tokens: parseInt(maxTokens),
        stream: false
    };

    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
        if (signal && signal.aborted) {
            throw new DOMException('Request aborted by user.', 'AbortError');
        }

        try {
            const response = await fetch(ENDPOINT, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload),
                signal: signal
            });

            // ── Success ──────────────────────────────────────────────────────
            if (response.ok) {
                const result = await response.json();
                const content = result?.choices?.[0]?.message?.content;

                if (content) {
                    return content.trim();
                }

                console.warn('Unexpected response structure:', result);
                throw new Error('Received an incomplete response from the server.');
            }

            // ── Auth failure ─────────────────────────────────────────────────
            if (response.status === 401 || response.status === 403) {
                throw new Error(
                    'Unauthorized. Verify your token is valid and has "Make calls to Inference Providers" permission enabled at huggingface.co/settings/tokens.'
                );
            }

            // ── Payment / credits exhausted ──────────────────────────────────
            if (response.status === 402) {
                throw new Error(
                    'Free inference credits exhausted. Add credits at huggingface.co/settings/billing, or switch to a different model.'
                );
            }

            // ── Rate limited ─────────────────────────────────────────────────
            if (response.status === 429) {
                if (onWarmUp) onWarmUp(30);
                attempts++;
                console.warn(`Rate limited. Waiting before retry ${attempts}/${maxAttempts}...`);
                await sleep(5000 * attempts);
                continue;
            }

            // ── Model loading / service unavailable ──────────────────────────
            if (response.status === 503) {
                let estTime = 20;
                try {
                    const errData = await response.json();
                    estTime = errData.estimated_time || 20;
                } catch (_) { /* ignore json parse failure */ }

                if (onWarmUp) onWarmUp(Math.round(estTime));
                attempts++;
                console.log(`Model loading. Retry ${attempts}/${maxAttempts}. ~${estTime}s remaining.`);
                await sleep(Math.min(4000 * attempts, estTime * 1000));
                continue;
            }

            // ── Model not found ───────────────────────────────────────────────
            if (response.status === 404) {
                throw new Error(
                    `Model not found: "${modelId}". This model may not be available via Inference Providers. Try selecting a different model.`
                );
            }

            // ── Other server error ────────────────────────────────────────────
            const rawText = await response.text();
            throw new Error(`Server error (${response.status}): ${rawText || response.statusText}`);

        } catch (err) {
            if (err.name === 'AbortError') throw err;

            // "Failed to fetch" = network-level block (CORS / gated model)
            if (err instanceof TypeError && err.message.includes('fetch')) {
                throw new Error(
                    'Network request blocked. This usually happens when the selected model is gated (requires accepted license terms on huggingface.co) or the token lacks "Make calls to Inference Providers" permission.\n\nTry switching to a non-gated model like "Llama 3.2 3B" from the dropdown.'
                );
            }

            if (attempts >= maxAttempts - 1) throw err;

            attempts++;
            console.warn(`Request failed. Retrying ${attempts}/${maxAttempts}...`, err);
            await sleep(2500);
        }
    }

    throw new Error('The model failed to respond after multiple retries. Please try again or switch models.');
}

/**
 * Sends a chat prompt to the secure server proxy endpoint.
 *
 * @param {object}   params
 * @param {string}   params.modelId      - Model ID
 * @param {string}   params.systemPrompt - System personality prompt
 * @param {Array}    params.messages      - Chat history
 * @param {number}   params.temperature  - Temperature
 * @param {number}   params.maxTokens    - Max tokens
 * @param {AbortSignal} params.signal    - AbortController signal
 * @returns {Promise<string>}            - The assistant reply text
 */
export async function queryChatbotProxy({
    modelId,
    systemPrompt,
    messages,
    temperature = 0.7,
    maxTokens = 1024,
    signal
}) {
    const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            modelId,
            systemPrompt,
            messages,
            temperature,
            maxTokens
        }),
        signal
    });

    if (!response.ok) {
        let errMsg = 'Failed to get response from server proxy.';
        try {
            const errData = await response.json();
            errMsg = errData.error || errMsg;
        } catch (_) {}
        throw new Error(errMsg);
    }

    const data = await response.json();
    if (!data || !data.content) {
        throw new Error('Server proxy returned an empty response content.');
    }

    return data.content;
}
